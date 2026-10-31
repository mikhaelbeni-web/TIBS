import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { inboxDocId, type InboxDoc, type InboxFacture, type InboxItem, type InboxSource, type InboxUber } from "@/lib/ingest";
import { bodyText, classify, displayNameOf, emailOf, gmailQuery, header, mergeRules, pdfAttachments, type GmailMessage, type MailRules } from "@/lib/mail";
import { adminDb } from "@/lib/server/admin";
import { extractFacture, extractionEnabled, extractUber } from "@/lib/server/extract";
import { getAttachment, getMessage, GoogleAuthError, listMessageIds, refreshAccessToken } from "@/lib/server/google";

/**
 * Relevé quotidien de la boîte mail du restaurant.
 * - private/gmail : refresh token (aucun accès depuis le navigateur)
 * - settings/mail : état visible par le gérant (adresse, dernier passage, résultat, règles de tri)
 * - mailLog/{messageId} : messages déjà traités, pour ne jamais les relire
 * - inbox : éléments trouvés, en attente de validation dans « À vérifier »
 */

export interface SyncResult {
  status: "ok" | "non_connecte" | "reconnexion" | "erreur";
  messagesVus: number;
  nouveaux: number; // éléments ajoutés dans « À vérifier »
  ignores: number;
  erreurs: number;
  incomplet: boolean; // vrai si le temps imparti a été atteint : la suite au prochain passage
  message?: string;
}

const MAX_PDF_BYTES = 15 * 1024 * 1024;
const MAX_PDF_PER_MAIL = 6;
const DAY = 86_400_000;

function sourceOf(msg: GmailMessage, attachment?: string): InboxSource {
  const received = Number(msg.internalDate);
  return {
    messageId: msg.id,
    ...(header(msg, "From") ? { from: header(msg, "From").slice(0, 200) } : {}),
    ...(header(msg, "Subject") ? { subject: header(msg, "Subject").slice(0, 300) } : {}),
    ...(Number.isFinite(received) ? { receivedAt: new Date(received).toISOString() } : {}),
    ...(attachment ? { attachment: attachment.slice(0, 200) } : {}),
  };
}

async function pdfData(token: string, msg: GmailMessage, ref: ReturnType<typeof pdfAttachments>[number]): Promise<string> {
  if (ref.data) return Buffer.from(ref.data, "base64url").toString("base64");
  return getAttachment(token, msg.id, ref.attachmentId!);
}

async function itemsFor(token: string, msg: GmailMessage, kind: "facture" | "uber"): Promise<InboxItem[]> {
  const from = header(msg, "From");
  const subject = header(msg, "Subject");
  const pdfs = pdfAttachments(msg).filter((p) => p.size <= MAX_PDF_BYTES).slice(0, MAX_PDF_PER_MAIL);
  const ai = extractionEnabled();

  if (kind === "uber") {
    const receivedAt = sourceOf(msg).receivedAt ?? "";
    const base: InboxUber = { kind: "uber", source: sourceOf(msg, pdfs[0]?.filename) };
    if (!ai) return [{ ...base, ...(receivedAt ? { date: receivedAt.slice(0, 10) } : {}), incomplet: true }];
    const pdf = pdfs[0] ? await pdfData(token, msg, pdfs[0]) : undefined;
    const r = await extractUber(bodyText(msg), pdf, { from, subject, receivedAt });
    if (!r) return [];
    return [{ ...base, ...r, ...(r.date && r.montant !== undefined ? {} : { incomplet: true }) }];
  }

  const items: InboxFacture[] = [];
  for (const p of pdfs) {
    const base: InboxFacture = { kind: "facture", fournisseur: displayNameOf(from).slice(0, 120), source: sourceOf(msg, p.filename) };
    if (!ai) {
      items.push({ ...base, incomplet: true });
      continue;
    }
    const r = await extractFacture(await pdfData(token, msg, p), { from, subject, filename: p.filename });
    if (!r) continue; // PDF qui n'est pas une facture (CGV, bon de livraison…)
    const complete = r.fournisseur && r.dateFacture && r.montantTTC !== undefined;
    items.push({ ...base, ...r, fournisseur: (r.fournisseur || base.fournisseur).slice(0, 120), ...(complete ? {} : { incomplet: true }) });
  }
  return items;
}

export async function syncMail({ budgetMs = 240_000 }: { budgetMs?: number } = {}): Promise<SyncResult> {
  const started = Date.now();
  const db = adminDb();
  const statusRef = db.doc("settings/mail");
  const result: SyncResult = { status: "ok", messagesVus: 0, nouveaux: 0, ignores: 0, erreurs: 0, incomplet: false };

  const priv = await db.doc("private/gmail").get();
  const refreshToken = priv.get("refreshToken") as string | undefined;
  if (!refreshToken) return { ...result, status: "non_connecte", message: "Boîte Gmail non connectée." };

  const status = (await statusRef.get()).data() ?? {};
  const rules: MailRules = mergeRules(status.regles);
  const lastRun = typeof status.dernierPassage === "number" ? status.dernierPassage : 0;
  // Premier passage : 31 jours en arrière. Ensuite : depuis le dernier passage, avec 2 jours de marge.
  const days = lastRun ? Math.min(31, Math.max(3, Math.ceil((started - lastRun) / DAY) + 2)) : 31;

  try {
    const token = await refreshAccessToken(refreshToken);
    const suppliers = await db.collection("suppliers").get();
    const supplierEmails = suppliers.docs.map((d) => String(d.get("email") ?? "").trim().toLowerCase()).filter((e) => e.includes("@"));

    const ids = (await listMessageIds(token, gmailQuery(days, rules))).reverse(); // du plus ancien au plus récent
    const logs = await Promise.all(ids.map((id) => db.doc(`mailLog/${id}`).get()));
    const todo = ids.filter((_, i) => !logs[i].exists);

    for (const id of todo) {
      if (Date.now() - started > budgetMs) {
        result.incomplet = true;
        break;
      }
      result.messagesVus++;
      try {
        const msg = await getMessage(token, id);
        const kind = classify(msg, rules, supplierEmails);
        const items = kind ? await itemsFor(token, msg, kind) : [];
        const now = Date.now();
        for (const [n, item] of items.entries()) {
          const doc: InboxDoc = { item, statut: "a_verifier", receivedAt: now };
          try {
            await db.collection("inbox").doc(inboxDocId(id, n)).create(doc);
            result.nouveaux++;
          } catch (e) {
            if ((e as { code?: number }).code !== 6) throw e; // 6 = déjà présent
          }
        }
        if (!items.length) result.ignores++;
        await db.doc(`mailLog/${id}`).set({
          traiteLe: now,
          type: kind ?? "ignore",
          elements: items.length,
          de: emailOf(header(msg, "From")).slice(0, 200),
          objet: header(msg, "Subject").slice(0, 300),
        });
      } catch (e) {
        if (e instanceof GoogleAuthError) throw e;
        // Pas de mailLog : le message sera retenté au prochain passage.
        result.erreurs++;
        console.error(`mail ${id}:`, (e as Error).message);
      }
    }
  } catch (e) {
    const reconnect = e instanceof GoogleAuthError;
    const out: SyncResult = { ...result, status: reconnect ? "reconnexion" : "erreur", message: (e as Error).message };
    await statusRef.set({ erreur: out.message, dernierEssai: Date.now() }, { merge: true });
    return out;
  }

  await statusRef.set(
    {
      // Passage interrompu (temps écoulé) : on garde l'ancienne date pour que la fenêtre de recherche couvre la suite.
      ...(result.incomplet ? {} : { dernierPassage: started }),
      dernierEssai: started,
      dernierResultat: { ...result, duree: Date.now() - started, lecturePdf: extractionEnabled() },
      erreur: FieldValue.delete(),
    },
    { merge: true },
  );
  return result;
}
