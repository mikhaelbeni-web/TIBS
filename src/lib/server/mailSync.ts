import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { inboxDocId, type InboxDoc, type InboxFacture, type InboxItem, type InboxSource, type InboxUber } from "@/lib/ingest";
import {
  bodyText,
  classify,
  displayNameOf,
  emailOf,
  etablissementOf,
  gmailQuery,
  header,
  knownSupplier,
  mergeRules,
  parseFactureText,
  parseUberRecap,
  pdfAttachments,
  type GmailMessage,
  type MailRules,
} from "@/lib/mail";
import { RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
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
  doublons: number; // factures déjà reçues ou saisies (même fournisseur, même numéro)
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

/** Date du jour à Paris (le récap Uber arrive le lundi vers 1 h, soit le dimanche soir en UTC). */
const parisDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });

interface Ctx {
  rules: MailRules;
  supplierByEmail: Map<string, string>;
}

async function itemsFor(token: string, msg: GmailMessage, kind: "facture" | "uber", ctx: Ctx): Promise<InboxItem[]> {
  const from = header(msg, "From");
  const subject = header(msg, "Subject");
  const body = bodyText(msg);
  const pdfs = pdfAttachments(msg).filter((p) => p.size <= MAX_PDF_BYTES).slice(0, MAX_PDF_PER_MAIL);
  const ai = extractionEnabled();

  if (kind === "uber") {
    const receivedAt = sourceOf(msg).receivedAt ?? "";
    const base: InboxUber = { kind: "uber", source: sourceOf(msg, pdfs[0]?.filename) };
    // Récap hebdo : tout est dans le corps, pas besoin d'IA.
    const t = parseUberRecap(subject, body);
    if (t.versementBancaire !== undefined) {
      const item: InboxUber = {
        ...base,
        ...(receivedAt ? { date: parisDate(receivedAt) } : {}),
        montant: t.versementBancaire,
        ...(t.revenusTotaux !== undefined ? { brut: t.revenusTotaux } : {}),
        ...(t.fraisUber !== undefined ? { frais: Math.abs(t.fraisUber) } : {}),
        ...(t.periode ? { reference: `Semaine du ${t.periode}`.slice(0, 60) } : {}),
      };
      return [{ ...item, ...(item.date ? {} : { incomplet: true }) }];
    }
    if (!ai) return [{ ...base, ...(receivedAt ? { date: parisDate(receivedAt) } : {}), incomplet: true }];
    const pdf = pdfs[0] ? await pdfData(token, msg, pdfs[0]) : undefined;
    const r = await extractUber(body, pdf, { from, subject, receivedAt });
    if (!r) return [];
    return [{ ...base, ...r, ...(r.date && r.montant !== undefined ? {} : { incomplet: true }) }];
  }

  const email = emailOf(from);
  const known = knownSupplier(email, ctx.rules.fournisseurs) ?? ctx.supplierByEmail.get(email);
  const etablissement = etablissementOf(msg);
  const text = parseFactureText(subject, body);
  const finish = (it: InboxFacture): InboxFacture => {
    const complete = it.fournisseur && it.dateFacture && it.montantTTC !== undefined;
    return { ...it, fournisseur: it.fournisseur.slice(0, 120), ...(etablissement ? { etablissement } : {}), ...(complete ? {} : { incomplet: true }) };
  };

  // Fournisseur connu sans PDF (ex. Pennylane, e-facture) : le mail suffit.
  if (pdfs.length === 0) {
    return text.montantTTC !== undefined && known ? [finish({ kind: "facture", fournisseur: known, ...text, source: sourceOf(msg) })] : [];
  }

  const items: InboxFacture[] = [];
  for (const p of pdfs) {
    // Ce que dit le mail ne vaut que s'il n'y a qu'une facture jointe.
    const fromText = pdfs.length === 1 ? text : {};
    const base: InboxFacture = { kind: "facture", fournisseur: known ?? displayNameOf(from), ...fromText, source: sourceOf(msg, p.filename) };
    if (!ai) {
      items.push(finish(base));
      continue;
    }
    const r = await extractFacture(await pdfData(token, msg, p), { from, subject, filename: p.filename });
    if (!r) continue; // PDF qui n'est pas une facture (CGV, bon de livraison…)
    // Les valeurs écrites dans le mail priment (format fixe), le nom du fournisseur connu aussi (pour les doublons).
    items.push(finish({ ...base, ...r, ...fromText, fournisseur: known ?? r.fournisseur ?? base.fournisseur }));
  }
  return items;
}

/** Même fournisseur et même numéro déjà reçu (DUPLICATA, double envoi) ou déjà saisi dans Factures. */
async function isDuplicate(base: FirebaseFirestore.DocumentReference, item: InboxItem): Promise<boolean> {
  if (item.kind !== "facture" || !item.numero) return false;
  const nom = item.fournisseur.toLowerCase();
  const [inbox, invoices] = await Promise.all([
    base.collection("inbox").where("item.numero", "==", item.numero).get(),
    base.collection("invoices").where("numero", "==", item.numero).get(),
  ]);
  return (
    inbox.docs.some((d) => String(d.get("item.fournisseur") ?? "").toLowerCase() === nom && d.get("statut") !== "rejete") ||
    invoices.docs.some((d) => String(d.get("supplierNom") ?? "").toLowerCase() === nom)
  );
}

/**
 * Relève la boîte Gmail d'un restaurant. Une facture qui mentionne clairement l'autre restaurant
 * (adresse, Prony en copie…) est déposée dans « À vérifier » de cet autre restaurant.
 */
export async function syncMail(rid: RestaurantId, { budgetMs = 240_000 }: { budgetMs?: number } = {}): Promise<SyncResult> {
  const started = Date.now();
  const db = adminDb();
  const home = db.doc(`restaurants/${rid}`);
  const statusRef = home.collection("settings").doc("mail");
  const result: SyncResult = { status: "ok", messagesVus: 0, nouveaux: 0, ignores: 0, doublons: 0, erreurs: 0, incomplet: false };

  const priv = await home.collection("private").doc("gmail").get();
  const refreshToken = priv.get("refreshToken") as string | undefined;
  if (!refreshToken) return { ...result, status: "non_connecte", message: "Boîte Gmail non connectée." };

  const status = (await statusRef.get()).data() ?? {};
  const rules: MailRules = mergeRules(status.regles);
  const lastRun = typeof status.dernierPassage === "number" ? status.dernierPassage : 0;
  // Premier passage : 31 jours en arrière. Ensuite : depuis le dernier passage, avec 2 jours de marge.
  const days = lastRun ? Math.min(31, Math.max(3, Math.ceil((started - lastRun) / DAY) + 2)) : 31;

  try {
    const token = await refreshAccessToken(refreshToken);
    const suppliers = await home.collection("suppliers").get();
    const supplierByEmail = new Map(
      suppliers.docs
        .map((d) => [String(d.get("email") ?? "").trim().toLowerCase(), String(d.get("nom") ?? "")] as const)
        .filter(([e, n]) => e.includes("@") && n),
    );
    const supplierEmails = [...supplierByEmail.keys()];

    const ids = (await listMessageIds(token, gmailQuery(days, rules))).reverse(); // du plus ancien au plus récent
    const logs = await Promise.all(ids.map((id) => home.collection("mailLog").doc(id).get()));
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
        const items = kind ? await itemsFor(token, msg, kind, { rules, supplierByEmail }) : [];
        const now = Date.now();
        for (const [n, item] of items.entries()) {
          // Pièce qui concerne clairement l'autre restaurant : elle va dans son « À vérifier ».
          const target = item.kind === "facture" && item.etablissement && item.etablissement !== rid ? db.doc(`restaurants/${item.etablissement}`) : home;
          if (await isDuplicate(target, item)) {
            result.doublons++;
            continue;
          }
          const doc: InboxDoc = { item, statut: "a_verifier", receivedAt: now };
          try {
            await target.collection("inbox").doc(inboxDocId(id, n)).create(doc);
            result.nouveaux++;
          } catch (e) {
            if ((e as { code?: number }).code !== 6) throw e; // 6 = déjà présent
          }
        }
        if (!items.length) result.ignores++;
        await home.collection("mailLog").doc(id).set({
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

/** Relève les boîtes de tous les restaurants connectés, en partageant le temps disponible. */
export async function syncAll(budgetMs: number): Promise<Record<RestaurantId, SyncResult>> {
  const started = Date.now();
  const out = {} as Record<RestaurantId, SyncResult>;
  for (const [i, r] of RESTAURANTS.entries()) {
    const left = budgetMs - (Date.now() - started);
    out[r.id] = await syncMail(r.id, { budgetMs: Math.max(10_000, left / (RESTAURANTS.length - i)) });
  }
  return out;
}

export interface RelireResult {
  status: "ok" | "non_connecte" | "sans_cle" | "erreur";
  relus: number;
  completes: number;
  restants: number;
  message?: string;
}

/**
 * Relit avec Claude les PDF des éléments « À compléter » déjà dans la liste (par exemple ceux reçus
 * avant l'ajout de ANTHROPIC_API_KEY). Ne remplit que les champs vides : rien de ce qui est déjà
 * renseigné n'est écrasé.
 */
export async function relireIncomplets(rid: RestaurantId, { budgetMs = 240_000 }: { budgetMs?: number } = {}): Promise<RelireResult> {
  const started = Date.now();
  const out: RelireResult = { status: "ok", relus: 0, completes: 0, restants: 0 };
  if (!extractionEnabled()) return { ...out, status: "sans_cle", message: "Ajoute ANTHROPIC_API_KEY dans Vercel pour activer la lecture des PDF." };
  const home = adminDb().doc(`restaurants/${rid}`);
  const refreshToken = (await home.collection("private").doc("gmail").get()).get("refreshToken") as string | undefined;
  if (!refreshToken) return { ...out, status: "non_connecte", message: "Boîte Gmail non connectée." };

  const docs = (await home.collection("inbox").where("statut", "==", "a_verifier").get()).docs.filter(
    (d) => d.get("item.incomplet") === true && d.get("item.source.messageId"),
  );
  out.restants = docs.length;
  if (!docs.length) return out;

  try {
    const token = await refreshAccessToken(refreshToken);
    for (const d of docs) {
      if (Date.now() - started > budgetMs) break;
      const item = d.get("item") as InboxItem;
      try {
        const msg = await getMessage(token, item.source!.messageId);
        const from = header(msg, "From");
        const subject = header(msg, "Subject");
        const pdfs = pdfAttachments(msg).filter((p) => p.size <= MAX_PDF_BYTES);
        const pdf = pdfs.find((p) => p.filename === item.source?.attachment) ?? pdfs[0];
        let next: InboxItem | null = null;
        if (item.kind === "facture") {
          if (!pdf) continue;
          const r = await extractFacture(await pdfData(token, msg, pdf), { from, subject, filename: pdf.filename });
          if (r) {
            const merged: InboxFacture = { ...r, ...dropEmpty(item), kind: "facture", source: item.source!, fournisseur: item.fournisseur || r.fournisseur || "" };
            const complete = merged.fournisseur && merged.dateFacture && merged.montantTTC !== undefined;
            next = { ...merged, incomplet: complete ? undefined : true } as InboxFacture;
          }
        } else {
          const receivedAt = sourceOf(msg).receivedAt ?? "";
          const r = await extractUber(bodyText(msg), pdf ? await pdfData(token, msg, pdf) : undefined, { from, subject, receivedAt });
          if (r) {
            const merged: InboxUber = { ...r, ...dropEmpty(item), kind: "uber", source: item.source! };
            next = { ...merged, incomplet: merged.date && merged.montant !== undefined ? undefined : true } as InboxUber;
          }
        }
        out.relus++;
        if (next) {
          if (!next.incomplet) {
            delete next.incomplet;
            out.completes++;
            out.restants--;
          }
          await d.ref.update({ item: JSON.parse(JSON.stringify(next)), relu: Date.now() });
        }
      } catch (e) {
        if (e instanceof GoogleAuthError) throw e;
        console.error("relire", d.id, e);
      }
    }
  } catch (e) {
    return { ...out, status: "erreur", message: e instanceof GoogleAuthError ? "Accès Gmail expiré : reconnecte la boîte." : (e as Error).message };
  }
  return out;
}

/** Garde uniquement les champs renseignés (pour ne pas écraser une valeur lue par une valeur vide). */
function dropEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== "incomplet" && v !== undefined && v !== "" && v !== null)) as Partial<T>;
}
