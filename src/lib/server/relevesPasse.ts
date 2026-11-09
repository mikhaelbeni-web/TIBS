import "server-only";
import { displayNameOf, emailOf, etablissementOf, header, knownSupplier, mergeRules, pdfAttachments } from "@/lib/mail";
import { derniereReclamation, facturesPourReleve, lignesAReclamer, moisReleve } from "@/lib/reclamation";
import { normNumero, rapprocher, type Releve } from "@/lib/releves";
import { RESTAURANT_IDS, type RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { estReleve, extractFacture } from "@/lib/server/extract";
import { getMessage, listMessageIds } from "@/lib/server/google";
import { enregistrerConsommation, enregistrerReleve, jetonBoite, lecteurPour, pdfData, sourceOf } from "@/lib/server/mailSync";
import type { Invoice, WithId } from "@/lib/types";

/**
 * Relevés / récapitulatifs de factures envoyés par les fournisseurs, une fois par jour :
 * 1. repérage : les mails qui y ressemblent (objet ou nom du PDF), y compris d'expéditeurs inconnus ou écartés
 *    avant, sont lus par l'IA ; seuls les vrais relevés sont gardés (jamais de facture créée ici) ;
 * 2. contrôle : pour chaque ligne du relevé sans facture dans l'app, on cherche son numéro dans les deux boîtes.
 *    Trouvée = elle attend d'être relevée ; introuvable = vraiment manquante, à réclamer au fournisseur.
 */
export const REQUETE_RELEVES =
  "-in:sent -in:spam -in:trash -from:me -from:uber.com -from:caisse-epargne.fr has:attachment filename:pdf " +
  '(subject:(relevé OR releve OR récapitulatif OR recapitulatif OR "situation de compte" OR "extrait de compte" OR "extrait compte" OR "état de compte" OR "etat de compte") ' +
  "OR filename:(releve OR relevé OR recapitulatif OR situation OR rlv))";
/** Objets qui ne sont jamais un relevé de factures fournisseur. */
const PAS_RELEVE = /sinistr|assurance|r[ée]siliation|m[ée]diateur|charges (immeuble|locataire)|course|dons|commande infogreffe|monetico|american ?express|d[ée]pannage/i;

const JOUR = 86_400_000;
const MAX_LECTURES = 6;

export interface PasseRelevesResult {
  lus: number;
  releves: number;
  verifies: number;
  manquantes: number;
  trouveesDansBoite: number;
  incomplet?: boolean;
}

export async function passeReleves(
  rid: RestaurantId,
  { budgetMs = 60_000, force = false, maxLectures = MAX_LECTURES }: { budgetMs?: number; force?: boolean; maxLectures?: number } = {},
): Promise<PasseRelevesResult | null> {
  const started = Date.now();
  const db = adminDb();
  const home = db.doc(`restaurants/${rid}`);
  const statusRef = home.collection("settings").doc("mail");
  const status = (await statusRef.get()).data() ?? {};
  const passe = (status.relevesPasse ?? {}) as { le?: number };
  if (!force && passe.le && Date.now() - passe.le < 20 * 3_600_000) return null;
  const tokens = new Map<RestaurantId, Promise<string | null>>();
  const token = await jetonBoite(rid, tokens);
  if (!token) return null;
  const out: PasseRelevesResult = { lus: 0, releves: 0, verifies: 0, manquantes: 0, trouveesDansBoite: 0 };
  const fournisseursManquants = new Set<string>();
  let reclamees = 0;

  // 1. Repérage des relevés depuis le 1er janvier.
  const rules = mergeRules(status.regles);
  const lecteur = lecteurPour(status);
  const ids = await listMessageIds(token, `after:2026/01/01 ${REQUETE_RELEVES}`, 400);
  const logs = ids.length ? await db.getAll(...ids.map((id) => home.collection("mailLog").doc(id))) : [];
  const aLire = ids.filter((_, i) => !logs[i].exists || (logs[i].get("type") === "ignore" && !logs[i].get("releveVu")));
  for (const id of aLire) {
    if (Date.now() - started > budgetMs / 2 || out.lus >= maxLectures || !lecteur.peutLire()) {
      out.incomplet = true;
      break;
    }
    const msg = await getMessage(token, id);
    const from = header(msg, "From");
    const subject = header(msg, "Subject");
    const exclu = PAS_RELEVE.test(subject) || rules.ignorer.some((r) => emailOf(from).endsWith(r) || subject.toLowerCase().includes(r));
    let n = 0;
    if (!exclu) {
      const nom = knownSupplier(emailOf(from), rules.fournisseurs);
      // Le relevé lui-même (pas les factures jointes à côté) : PDF dont le nom évoque un relevé, sinon le premier.
      const pdfs = pdfAttachments(msg);
      const p = pdfs.find((x) => /relev|rlv|recap|situation|compte|extrait/i.test(x.filename)) ?? pdfs[0];
      if (p) {
        out.lus++;
        const r = await extractFacture(await pdfData(token, msg, p), { from, subject, filename: p.filename }, lecteur).catch(() => null);
        if (r && estReleve(r) && r.lignes.length) {
          const cible = etablissementOf(msg) ?? rid;
          await enregistrerReleve(cible, nom ?? r.fournisseur ?? displayNameOf(from), r, { ...sourceOf(msg, p.filename), boite: rid });
          out.releves++;
          n = 1;
        }
      }
    }
    const log = home.collection("mailLog").doc(id);
    await log.set({ releveVu: true, ...(n ? { releve: n } : {}), ...(logs[ids.indexOf(id)].exists ? {} : { traiteLe: Date.now(), type: "ignore", elements: 0, de: emailOf(from).slice(0, 200), objet: subject.slice(0, 300) }) }, { merge: true });
  }
  await enregistrerConsommation(statusRef, lecteur);

  // 2. Contrôle des lignes sans facture.
  const [releves, invoices, attente] = await Promise.all([
    home.collection("releves").get(),
    home.collection("invoices").select("supplierId", "supplierNom", "numero", "dateFacture", "montantTTC", "statut", "mois").get(),
    home.collection("inbox").where("statut", "==", "a_verifier").select("item.numero").get(),
  ]);
  const factures = invoices.docs.map((d) => ({ id: d.id, ...(d.data() as Invoice) })) as WithId<Invoice>[];
  const enAttente = attente.docs.map((d) => String(d.get("item.numero") ?? "")).filter(Boolean);
  for (const d of releves.docs) {
    const x = d.data() as Releve;
    // Ancien calcul du mois (période d'exercice) : on le corrige.
    const mois = moisReleve(x, x.source?.receivedAt);
    if (mois !== x.mois) await d.ref.update({ mois });
    const manquantes = lignesAReclamer(rapprocher(x, facturesPourReleve(x, factures), enAttente), x.justifies);
    if (!manquantes.length) continue;
    if (Date.now() - started > budgetMs) {
      out.incomplet = true;
      continue;
    }
    // Une ligne déjà cherchée il y a moins de 3 jours n'est pas recherchée à nouveau.
    const recent = x.verif && Date.now() - x.verif.le < 3 * JOUR;
    const aChercher = manquantes.filter((l) => !(recent && x.verif!.cherchees.includes(normNumero(l.numero))));
    if (aChercher.length) {
      const res = await chercherDansBoites(aChercher.map((l) => l.numero), x, tokens);
      await enregistrerVerif(d.ref, x, res);
      out.verifies += aChercher.length;
      Object.assign((x.verif ??= { le: 0, cherchees: [], trouvees: {} }).trouvees, res.trouvees);
    }
    for (const l of manquantes) {
      if (x.verif?.trouvees[normNumero(l.numero)]) out.trouveesDansBoite++;
      else if (derniereReclamation(x, l.numero)) reclamees++;
      else {
        out.manquantes++;
        fournisseursManquants.add(x.fournisseur);
      }
    }
  }
  await statusRef.set({ relevesPasse: { le: Date.now(), ...out } }, { merge: true });
  // Pour l'accueil (document déjà lu par la page) : rien d'autre à charger.
  await home
    .collection("settings")
    .doc("app")
    .set({ facturesManquantes: { aReclamer: out.manquantes, fournisseurs: fournisseursManquants.size, reclamees, le: Date.now() } }, { merge: true });
  return out;
}

type Trouvees = NonNullable<Releve["verif"]>["trouvees"];

/**
 * Cherche chaque numéro de facture dans les deux boîtes (objet, corps, nom ou texte du PDF).
 * Ne comptent pas : le mail du relevé lui-même, nos propres mails (réclamations), et les autres relevés.
 */
export async function chercherDansBoites(
  numeros: string[],
  releve: Pick<Releve, "source">,
  tokens = new Map<RestaurantId, Promise<string | null>>(),
): Promise<{ cherchees: string[]; trouvees: Trouvees }> {
  const trouvees: Trouvees = {};
  const cherchees: string[] = [];
  for (const numero of numeros.slice(0, 60)) {
    const n = normNumero(numero);
    if (!n || n.length < 4) continue;
    cherchees.push(n);
    for (const boite of RESTAURANT_IDS) {
      const token = await jetonBoite(boite, tokens).catch(() => null);
      if (!token) continue;
      const q = `"${numero.replace(/"/g, "")}" -in:sent -from:me -in:trash -in:spam`;
      const ids = (await listMessageIds(token, q, 10).catch(() => [])).filter((id) => id !== releve.source?.messageId);
      for (const id of ids) {
        const m = await getMessage(token, id).catch(() => null);
        if (!m) continue;
        const objet = header(m, "Subject");
        // Un autre relevé ou une relance liste aussi ce numéro : ce n'est pas la facture.
        if (/relev|r[ée]capitulatif|extrait|situation|relance|[ée]ch[ée]ance/i.test(objet) && !objet.toUpperCase().replace(/[^A-Z0-9]/g, "").includes(n)) continue;
        const recu = Number(m.internalDate);
        trouvees[n] = { boite, messageId: id, objet: objet.slice(0, 200), ...(Number.isFinite(recu) ? { date: new Date(recu).toISOString().slice(0, 10) } : {}) };
        break;
      }
      if (trouvees[n]) break;
    }
  }
  return { cherchees, trouvees };
}

export async function enregistrerVerif(ref: FirebaseFirestore.DocumentReference, x: Pick<Releve, "verif">, res: { cherchees: string[]; trouvees: Trouvees }) {
  const avant = x.verif;
  const cherchees = [...new Set([...(avant?.cherchees ?? []), ...res.cherchees])].slice(-300);
  // Une ligne cherchée de nouveau et introuvable n'est plus « trouvée ».
  const trouvees = Object.fromEntries(Object.entries({ ...(avant?.trouvees ?? {}) }).filter(([k]) => !res.cherchees.includes(k) || res.trouvees[k]));
  await ref.update({ verif: { le: Date.now(), cherchees, trouvees: { ...trouvees, ...res.trouvees } } });
}
