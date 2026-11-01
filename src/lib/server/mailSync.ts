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
  type Periode,
  header,
  knownSupplier,
  mergeRules,
  parseFactureText,
  parseUberRecap,
  pdfAttachments,
  type GmailMessage,
  type MailRules,
} from "@/lib/mail";
import { RESTAURANT_IDS, type RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { moisCle, parseConsommation, parseReglages } from "@/lib/reglages";
import { estReleve, extractFacture, extractUber, Lecteur, type ExtractedReleve } from "@/lib/server/extract";
import { estCoherent, releveDocId, type Releve } from "@/lib/releves";
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
  releves?: number; // relevés fournisseurs enregistrés
  lectures?: number; // PDF lus par Claude
  coutUsd?: number;
  limite?: "max" | "budget" | null; // lecture arrêtée par une limite des Réglages
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
  lecteur: Lecteur;
  /** Relevés trouvés dans le mail : enregistrés à part, jamais comme factures. */
  releves?: { releve: ExtractedReleve; nom: string; etablissement?: RestaurantId; source: InboxSource }[];
}

/**
 * Enregistre un relevé fournisseur (document de contrôle). Clé = fournisseur + n° de relevé :
 * un relevé renvoyé ou corrigé remplace le précédent.
 */
export async function enregistrerReleve(rid: RestaurantId, nom: string, x: ExtractedReleve, source: InboxSource): Promise<string> {
  const db = adminDb();
  const home = db.doc(`restaurants/${rid}`);
  const suppliers = await home.collection("suppliers").get();
  const sup = suppliers.docs.find((d) => String(d.get("nom") ?? "").toLowerCase() === nom.toLowerCase());
  const mois = (x.periodeFin ?? x.dateReleve ?? source.receivedAt ?? new Date().toISOString()).slice(0, 7);
  const id = releveDocId(nom, x.numero, x.periodeFin ? `${mois}` : source.messageId);
  const ref = home.collection("releves").doc(id);
  const avant = await ref.get();
  const releve: Releve = {
    fournisseur: nom.slice(0, 120),
    ...(sup ? { supplierId: sup.id } : {}),
    ...(x.numero ? { numero: x.numero.slice(0, 60) } : {}),
    ...(x.dateReleve ? { dateReleve: x.dateReleve } : {}),
    ...(x.periodeDebut ? { periodeDebut: x.periodeDebut } : {}),
    ...(x.periodeFin ? { periodeFin: x.periodeFin } : {}),
    mois,
    ...(x.totalTTC !== undefined ? { totalTTC: x.totalTTC } : {}),
    ...(x.soldeAnterieur !== undefined ? { soldeAnterieur: x.soldeAnterieur } : {}),
    ...(x.netAPayer !== undefined ? { netAPayer: x.netAPayer } : {}),
    ...(x.compteClient ? { compteClient: x.compteClient } : {}),
    lignes: x.lignes,
    coherent: estCoherent(x),
    ...(avant.get("justifies") ? { justifies: avant.get("justifies") } : {}),
    source: JSON.parse(JSON.stringify(source)),
    createdAt: Date.now(),
  };
  await ref.set(releve);
  return id;
}

/** Ajoute la dépense de la vérification au compteur du mois (settings/mail.consommation.AAAA-MM). */
async function enregistrerConsommation(statusRef: FirebaseFirestore.DocumentReference, l: Lecteur) {
  if (!l.lectures) return;
  const m = moisCle();
  await statusRef.set(
    {
      consommation: {
        [m]: {
          lectures: FieldValue.increment(l.lectures),
          entree: FieldValue.increment(l.entree),
          sortie: FieldValue.increment(l.sortie),
          coutUsd: FieldValue.increment(Math.round(l.cout * 10_000) / 10_000),
        },
      },
    },
    { merge: true },
  );
}

/** Compteur de lecture pour un restaurant, d'après ses réglages et sa dépense du mois. */
function lecteurPour(status: FirebaseFirestore.DocumentData) {
  const reglages = parseReglages(status.reglages);
  const depense = parseConsommation(status.consommation?.[moisCle()]).coutUsd;
  return new Lecteur(reglages, depense);
}

async function itemsFor(token: string, msg: GmailMessage, kind: "facture" | "uber", ctx: Ctx): Promise<InboxItem[]> {
  const from = header(msg, "From");
  const subject = header(msg, "Subject");
  const body = bodyText(msg);
  const pdfs = pdfAttachments(msg).filter((p) => p.size <= MAX_PDF_BYTES).slice(0, MAX_PDF_PER_MAIL);

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
    if (!ctx.lecteur.peutLire()) return [{ ...base, ...(receivedAt ? { date: parisDate(receivedAt) } : {}), incomplet: true, lecture: ctx.lecteur.raison }];
    const pdf = pdfs[0] ? await pdfData(token, msg, pdfs[0]) : undefined;
    const r = await extractUber(body, pdf, { from, subject, receivedAt }, ctx.lecteur);
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
    if (!ctx.lecteur.peutLire()) {
      const it = finish(base);
      items.push(it.incomplet ? { ...it, lecture: ctx.lecteur.raison } : it);
      continue;
    }
    const r = await extractFacture(await pdfData(token, msg, p), { from, subject, filename: p.filename }, ctx.lecteur);
    if (!r) continue; // PDF qui n'est pas une facture (CGV, bon de livraison…)
    if (estReleve(r)) {
      ctx.releves?.push({ releve: r, nom: known ?? r.fournisseur ?? base.fournisseur, etablissement, source: base.source });
      continue;
    }
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
 * Éléments « À vérifier » créés avant l'ajout de source.boite : on retrouve leur boîte d'origine
 * grâce au journal mailLog (un mail n'est journalisé que dans la boîte qui l'a relevé).
 */
async function marquerBoite(rid: RestaurantId) {
  const db = adminDb();
  for (const cible of RESTAURANT_IDS) {
    const docs = (await db.collection(`restaurants/${cible}/inbox`).where("statut", "==", "a_verifier").get()).docs.filter(
      (d) => !d.get("item.source.boite") && d.get("item.source.messageId"),
    );
    for (const d of docs) {
      const log = await db.doc(`restaurants/${rid}/mailLog/${d.get("item.source.messageId")}`).get();
      if (log.exists) await d.ref.update({ "item.source.boite": rid });
    }
  }
}

/** Jeton Gmail de la boîte d'un restaurant (mis en cache pour un passage). */
export async function jetonBoite(rid: RestaurantId, cache = new Map<RestaurantId, Promise<string | null>>()): Promise<string | null> {
  if (!cache.has(rid)) {
    cache.set(
      rid,
      (async () => {
        const refresh = (await adminDb().doc(`restaurants/${rid}/private/gmail`).get()).get("refreshToken") as string | undefined;
        return refresh ? refreshAccessToken(refresh) : null;
      })(),
    );
  }
  return cache.get(rid)!;
}

/**
 * Relève la boîte Gmail d'un restaurant. Une facture qui mentionne clairement l'autre restaurant
 * (adresse, Prony en copie…) est déposée dans « À vérifier » de cet autre restaurant.
 */
export async function syncMail(
  rid: RestaurantId,
  { budgetMs = 240_000, periode = null }: { budgetMs?: number; periode?: Periode | null } = {},
): Promise<SyncResult> {
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
  const lecteur = lecteurPour(status);
  const maxJours = lecteur.reglages.joursPremierReleve;
  // Premier passage : N jours en arrière (Réglages, 31 par défaut). Ensuite : depuis le dernier passage, avec 2 jours de marge.
  const days = lastRun ? Math.min(maxJours, Math.max(3, Math.ceil((started - lastRun) / DAY) + 2)) : maxJours;

  try {
    const token = await refreshAccessToken(refreshToken);
    const suppliers = await home.collection("suppliers").get();
    const supplierByEmail = new Map(
      suppliers.docs
        .map((d) => [String(d.get("email") ?? "").trim().toLowerCase(), String(d.get("nom") ?? "")] as const)
        .filter(([e, n]) => e.includes("@") && n),
    );
    const supplierEmails = [...supplierByEmail.keys()];

    const ids = (await listMessageIds(token, gmailQuery(days, rules, periode))).reverse(); // du plus ancien au plus récent
    const logs = await Promise.all(ids.map((id) => home.collection("mailLog").doc(id).get()));
    // Recherche sur une période : on réexamine aussi les mails écartés (règles de tri changées depuis).
    // Ceux qui ont déjà donné un élément ne sont pas repris (pas de doublon dans « À vérifier »).
    const todo = ids.filter((_, i) => !logs[i].exists || (periode && logs[i].get("type") === "ignore"));

    for (const id of todo) {
      if (Date.now() - started > budgetMs) {
        result.incomplet = true;
        break;
      }
      result.messagesVus++;
      try {
        const msg = await getMessage(token, id);
        const kind = classify(msg, rules, supplierEmails);
        const releves: NonNullable<Ctx["releves"]> = [];
        const items = kind ? await itemsFor(token, msg, kind, { rules, supplierByEmail, lecteur, releves }) : [];
        for (const x of releves) {
          await enregistrerReleve(x.etablissement ?? rid, x.nom, x.releve, { ...x.source, boite: rid });
          result.releves = (result.releves ?? 0) + 1;
        }
        const now = Date.now();
        for (const [n, item] of items.entries()) {
          // Pièce qui concerne clairement l'autre restaurant : elle va dans son « À vérifier ».
          const target = item.kind === "facture" && item.etablissement && item.etablissement !== rid ? db.doc(`restaurants/${item.etablissement}`) : home;
          if (await isDuplicate(target, item)) {
            result.doublons++;
            continue;
          }
          const doc: InboxDoc = { item: { ...item, source: { ...item.source, boite: rid } } as InboxItem, statut: "a_verifier", receivedAt: now };
          try {
            await target.collection("inbox").doc(inboxDocId(id, n)).create(doc);
            result.nouveaux++;
          } catch (e) {
            if ((e as { code?: number }).code !== 6) throw e; // 6 = déjà présent
          }
        }
        if (!items.length && !releves.length) result.ignores++;
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
    await enregistrerConsommation(statusRef, lecteur);
    const reconnect = e instanceof GoogleAuthError;
    const out: SyncResult = { ...result, status: reconnect ? "reconnexion" : "erreur", message: (e as Error).message };
    await statusRef.set({ erreur: out.message, dernierEssai: Date.now() }, { merge: true });
    return out;
  }

  await marquerBoite(rid).catch((e) => console.error("marquerBoite:", (e as Error).message));
  result.lectures = lecteur.lectures;
  result.coutUsd = Math.round(lecteur.cout * 10_000) / 10_000;
  result.limite = lecteur.limite;
  await enregistrerConsommation(statusRef, lecteur);
  await statusRef.set(
    {
      // Passage interrompu (temps écoulé) : on garde l'ancienne date pour que la fenêtre de recherche couvre la suite.
      // Recherche sur une période choisie : ne décale pas le relevé automatique.
      ...(result.incomplet || periode ? {} : { dernierPassage: started }),
      dernierEssai: started,
      dernierResultat: { ...result, duree: Date.now() - started, lecturePdf: lecteur.actif },
      erreur: FieldValue.delete(),
    },
    { merge: true },
  );
  return result;
}

export interface RelireOptions {
  budgetMs?: number;
  /** Uniquement ces éléments (bouton de la fiche). */
  ids?: string[];
  /** Bouton « Lire les PDF avec l'IA » : relit aussi ceux déjà jugés illisibles ou en erreur. */
  force?: boolean;
}

export interface RelireResult {
  status: "ok" | "non_connecte" | "sans_cle" | "erreur";
  relus: number;
  completes: number;
  restants: number;
  limite?: "max" | "budget" | null;
  coutUsd?: number;
  message?: string;
}

/**
 * Relit avec Claude les PDF des éléments « À compléter » déjà dans la liste (par exemple ceux reçus
 * avant l'ajout de ANTHROPIC_API_KEY). Ne remplit que les champs vides : rien de ce qui est déjà
 * renseigné n'est écrasé.
 */
export async function relireIncomplets(rid: RestaurantId, { budgetMs = 240_000, ids, force = false }: RelireOptions = {}): Promise<RelireResult> {
  const started = Date.now();
  const out: RelireResult = { status: "ok", relus: 0, completes: 0, restants: 0 };
  const home = adminDb().doc(`restaurants/${rid}`);
  const statusRef = home.collection("settings").doc("mail");
  const lecteur = lecteurPour((await statusRef.get()).data() ?? {});
  if (!lecteur.actif) return { ...out, status: "sans_cle", message: "Lecture des PDF désactivée (clé ANTHROPIC_API_KEY absente ou coupée dans Réglages)." };
  const refreshToken = (await home.collection("private").doc("gmail").get()).get("refreshToken") as string | undefined;
  if (!refreshToken) return { ...out, status: "non_connecte", message: "Boîte Gmail non connectée." };

  // Relecture automatique : on ne repaie pas un PDF déjà jugé « pas une facture » ou en erreur.
  const docs = (await home.collection("inbox").where("statut", "==", "a_verifier").get()).docs.filter(
    (d) =>
      d.get("item.source.messageId") &&
      (ids ? ids.includes(d.id) : d.get("item.incomplet") === true && (force || !["pas_facture", "erreur"].includes(d.get("item.lecture")))),
  );
  out.restants = docs.length;
  if (!docs.length) return out;

  try {
    // Un élément peut venir de la boîte de l'autre restaurant : on lit le mail avec le jeton de sa boîte.
    const propre = refreshAccessToken(refreshToken);
    propre.catch(() => {}); // l'erreur remonte quand le jeton est utilisé
    const jetons = new Map<RestaurantId, Promise<string | null>>([[rid, propre]]);
    for (const d of docs) {
      if (Date.now() - started > budgetMs || !lecteur.peutLire()) break;
      const item = d.get("item") as InboxItem;
      const token = await jetonBoite(item.source?.boite ?? rid, jetons);
      if (!token) continue;
      try {
        const msg = await getMessage(token, item.source!.messageId);
        const from = header(msg, "From");
        const subject = header(msg, "Subject");
        const pdfs = pdfAttachments(msg).filter((p) => p.size <= MAX_PDF_BYTES);
        const pdf = pdfs.find((p) => p.filename === item.source?.attachment) ?? pdfs[0];
        let next: InboxItem | null = null;
        if (item.kind === "facture") {
          if (!pdf) {
            await d.ref.update({ "item.lecture": "pas_de_pdf" });
            continue;
          }
          const r = await extractFacture(await pdfData(token, msg, pdf), { from, subject, filename: pdf.filename }, lecteur);
          if (r && estReleve(r)) {
            // Un « récapitulatif » pris pour une facture : il devient un relevé et sort de « À vérifier ».
            await enregistrerReleve(item.kind === "facture" && item.etablissement ? item.etablissement : rid, item.fournisseur || r.fournisseur || "", r, item.source!);
            await d.ref.update({ statut: "releve", relu: Date.now() });
            out.relus++;
            out.restants--;
            continue;
          }
          if (r) {
            const merged: InboxFacture = { ...r, ...dropEmpty(item), kind: "facture", source: item.source!, fournisseur: item.fournisseur || r.fournisseur || "" };
            const complete = merged.fournisseur && merged.dateFacture && merged.montantTTC !== undefined;
            next = { ...merged, incomplet: complete ? undefined : true } as InboxFacture;
          }
        } else {
          const receivedAt = sourceOf(msg).receivedAt ?? "";
          const r = await extractUber(bodyText(msg), pdf ? await pdfData(token, msg, pdf) : undefined, { from, subject, receivedAt }, lecteur);
          if (r) {
            const merged: InboxUber = { ...r, ...dropEmpty(item), kind: "uber", source: item.source! };
            next = { ...merged, incomplet: merged.date && merged.montant !== undefined ? undefined : true } as InboxUber;
          }
        }
        out.relus++;
        if (next) {
          delete next.lecture;
          delete next.lectureErreur;
          if (!next.incomplet) {
            delete next.incomplet;
            out.completes++;
            out.restants--;
          }
          await d.ref.update({ item: JSON.parse(JSON.stringify(next)), relu: Date.now() });
        } else {
          await d.ref.update({ "item.lecture": "pas_facture", "item.lectureErreur": FieldValue.delete(), relu: Date.now() });
        }
      } catch (e) {
        if (e instanceof GoogleAuthError) throw e;
        console.error("relire", d.id, e);
        await d.ref.update({ "item.lecture": "erreur", "item.lectureErreur": String((e as Error).message).slice(0, 300), relu: Date.now() });
      }
    }
  } catch (e) {
    await enregistrerConsommation(statusRef, lecteur);
    return { ...out, status: "erreur", message: e instanceof GoogleAuthError ? "Accès Gmail expiré : reconnecte la boîte." : (e as Error).message };
  }
  await enregistrerConsommation(statusRef, lecteur);
  return { ...out, limite: lecteur.limite, coutUsd: Math.round(lecteur.cout * 10_000) / 10_000 };
}

/** Garde uniquement les champs renseignés (pour ne pas écraser une valeur lue par une valeur vide). */
function dropEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([k, v]) => k !== "incomplet" && v !== undefined && v !== "" && v !== null)) as Partial<T>;
}
