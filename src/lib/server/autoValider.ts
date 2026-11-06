import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { doutesFacture, factureAutoId, nomDansLeMail, type Doute } from "@/lib/autoValidation";
import type { InboxFacture } from "@/lib/ingest";
import { emailOf, mergeRules, senderMatches, type MailRules } from "@/lib/mail";
import { normNumero } from "@/lib/releves";
import { RESTAURANT_IDS, RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";

export interface AutoResult {
  valides: number;
  enDoute: number;
  /** Pièces que l'IA a jugées « pas une facture », rangées dans les lignes ignorées. */
  ignores?: number;
  /** Nombre de factures en attente par raison (une facture peut en avoir plusieurs). */
  raisons?: Partial<Record<Doute, number>>;
  /** Diagnostic : écrit dans les journaux Vercel (privés), jamais renvoyé (le journal GitHub Actions est public). */
  exemples?: { raisons: Doute[]; fournisseur: string; de: string; ht?: number; tva?: number; ttc?: number; date?: string; recu?: string; lecture?: string; erreur?: string }[];
}

const parisJour = (t = Date.now()) => new Date(t).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
const low = (s: unknown) => String(s ?? "").trim().toLowerCase();
const jours = (a: string, b: string) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;

/** Messageries grand public : une règle de domaine ne suffit pas, il faut l'adresse exacte. */
const MESSAGERIES = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|icloud|me|orange|wanadoo|free|sfr|laposte|aol|proton|protonmail)\./;

/**
 * Nom du fournisseur reconnu à l'expéditeur, ou null. Seule l'adresse d'envoi compte (jamais le nom lu
 * sur le PDF) ; les boîtes des restaurants (mails transférés) ne valent jamais pour un fournisseur.
 */
export function fournisseurDeLExpediteur(
  email: string,
  rules: MailRules,
  fiches: { nom: string; email: string }[],
  boitesRestaurants: string[],
): string | null {
  if (!email.includes("@") || boitesRestaurants.includes(email)) return null;
  const grandPublic = MESSAGERIES.test(email.split("@")[1] ?? "");
  const cles = Object.keys(rules.fournisseurs).filter((k) => senderMatches(email, [k]) && (!grandPublic || k.includes("@")));
  if (cles.length) {
    cles.sort((a, b) => Number(b.includes("@")) - Number(a.includes("@")) || b.length - a.length);
    return rules.fournisseurs[cles[0]];
  }
  const fiche = fiches.filter((f) => f.email === email);
  return fiche.length === 1 ? fiche[0].nom : null;
}

/**
 * Passe sur toutes les factures « À vérifier » d'un restaurant (nouvelles et arriéré) :
 * celles dont la lecture est cohérente sont enregistrées dans Factures sans clic,
 * les autres restent en attente avec leurs doutes (champ `doutes`, affiché dans la liste).
 * `sauf` : éléments que le gérant a ouverts (relecture d'une seule fiche), laissés tels quels.
 */
export async function validerAutomatiquement(rid: RestaurantId, { sauf = [] }: { sauf?: string[] } = {}): Promise<AutoResult> {
  const db = adminDb();
  const home = db.doc(`restaurants/${rid}`);
  const out: AutoResult = { valides: 0, enDoute: 0 };

  // Rien à valider (cas de la plupart des réveils) : on s'arrête avant de relire fournisseurs, factures et mails traités,
  // qui coûtent des milliers de lectures Firestore à chaque passage (quota gratuit : 50 000 par jour).
  const pending = await home.collection("inbox").where("statut", "==", "a_verifier").get();
  const factures = pending.docs.filter((d) => d.get("item.kind") === "facture" && !sauf.includes(d.id));
  if (!factures.length) return out;
  const [suppliersSnap, invoicesSnap, traites, ...statuts] = await Promise.all([
    home.collection("suppliers").get(),
    home.collection("invoices").get(),
    home.collection("inbox").where("statut", "in", ["valide", "releve"]).get(),
    ...RESTAURANT_IDS.map((r) => db.doc(`restaurants/${r}/settings/mail`).get()),
  ]);

  // Règles de tri de la boîte d'où vient le mail (une facture peut avoir été routée depuis l'autre restaurant).
  const rulesDe = new Map(RESTAURANT_IDS.map((r, i) => [r, mergeRules(statuts[i].get("regles"))]));
  const boites = [...RESTAURANTS.map((r) => r.boiteMail.toLowerCase()), ...statuts.map((s) => low(s.get("adresse")))].filter(Boolean);
  const suppliers = suppliersSnap.docs.map((d) => ({ id: d.id, nom: String(d.get("nom") ?? ""), email: low(d.get("email")) }));
  const invoices = invoicesSnap.docs.map((d) => ({
    supplierId: String(d.get("supplierId") ?? ""),
    nom: low(d.get("supplierNom")),
    numero: normNumero(String(d.get("numero") ?? "")),
    date: String(d.get("dateFacture") ?? ""),
    ttc: Number(d.get("montantTTC")),
  }));
  const factureDocs = [...pending.docs, ...traites.docs].filter((d) => d.get("item.kind") === "facture");
  const aujourdhui = parisJour();

  for (const d of factures) {
    const item = d.get("item") as InboxFacture;
    // L'IA a lu le PDF et n'y a vu ni facture ni avoir (confirmation de commande, CGV…) : rangé dans les lignes ignorées.
    if (item.lecture === "pas_facture" && d.get("remiseAVerifier") !== true) {
      await d.ref.update({ statut: "rejete", traiteLe: Date.now(), auto: true, doutes: FieldValue.delete() });
      out.ignores = (out.ignores ?? 0) + 1;
      continue;
    }
    const nom = low(item.fournisseur);
    const email = emailOf(item.source?.from ?? "");
    const reconnu = fournisseurDeLExpediteur(email, rulesDe.get(item.source?.boite ?? rid)!, suppliers, boites);
    const fiches = suppliers.filter((s) => low(s.nom) === nom);
    // Connu = l'expéditeur désigne ce fournisseur-là (règles, fiche), ou bien le mail porte le nom lu sur le PDF ;
    // jamais un mail transféré depuis une boîte du restaurant, et une seule fiche à ce nom.
    const parLeMail = reconnu === null && !boites.includes(email) && nomDansLeMail(item.fournisseur, item.source ?? {});
    const connu = ((reconnu !== null && low(reconnu) === nom) || parLeMail) && fiches.length <= 1;
    const fiche = fiches[0];
    const numero = normNumero(item.numero ?? "");
    const deCeFournisseur = invoices.filter((i) => (fiche && i.supplierId === fiche.id) || i.nom === nom);
    const doublon =
      deCeFournisseur.some(
        (i) => (numero && i.numero === numero) || (item.montantTTC !== undefined && i.ttc === item.montantTTC && item.dateFacture && i.date && jours(i.date, item.dateFacture) <= 3),
      ) ||
      factureDocs.some(
        (v) => v.id !== d.id && low(v.get("item.fournisseur")) === nom && Boolean(numero) && normNumero(String(v.get("item.numero") ?? "")) === numero,
      );

    const recu = item.source?.receivedAt ? Date.parse(item.source.receivedAt) : NaN;
    const doutes = doutesFacture(item, {
      aujourdhui,
      restaurant: rid,
      ...(Number.isFinite(recu) ? { recuLe: parisJour(recu) } : {}),
      fournisseurConnu: connu,
      fournisseurNouveau: parLeMail && fiches.length === 0,
      doublon,
      historiqueTTC: deCeFournisseur.map((i) => i.ttc).filter((n) => Number.isFinite(n) && n > 0),
      remiseAVerifier: d.get("remiseAVerifier") === true,
    });

    if (doutes.length) {
      out.enDoute++;
      out.raisons ??= {};
      for (const x of doutes) out.raisons[x] = (out.raisons[x] ?? 0) + 1;
      if ((out.exemples ??= []).length < 40)
        out.exemples.push({
          raisons: doutes,
          fournisseur: item.fournisseur.slice(0, 40),
          de: email.split("@")[1] ?? "",
          ht: item.montantHT,
          tva: item.montantTVA,
          ttc: item.montantTTC,
          date: item.dateFacture,
          recu: item.source?.receivedAt?.slice(0, 10),
          lecture: item.lecture,
          erreur: item.lectureErreur?.slice(0, 80),
        });
      const avant = (d.get("doutes") as Doute[] | undefined) ?? [];
      if (avant.join() !== doutes.join()) await d.ref.update({ doutes });
      continue;
    }

    const ok = await db
      .runTransaction(async (tx) => {
        const fresh = await tx.get(d.ref);
        // Déjà traitée (bouton manuel, autre passage) ou relue entre-temps : on ne touche à rien.
        if (fresh.get("statut") !== "a_verifier" || fresh.get("remiseAVerifier") === true || fresh.get("relu") !== d.get("relu")) return false;
        const now = Date.now();
        const supplierRef = fiche ? home.collection("suppliers").doc(fiche.id) : home.collection("suppliers").doc();
        if (!fiche) tx.create(supplierRef, { nom: item.fournisseur.trim(), email, createdAt: now });
        const invoiceRef = home.collection("invoices").doc(factureAutoId(d.id));
        tx.create(invoiceRef, {
          supplierId: supplierRef.id,
          supplierNom: fiche?.nom ?? item.fournisseur.trim(),
          numero: item.numero!.trim(),
          dateFacture: item.dateFacture!,
          mois: item.dateFacture!.slice(0, 7),
          ...(item.dateEcheance ? { dateEcheance: item.dateEcheance } : {}),
          montantHT: item.montantHT!,
          montantTVA: item.montantTVA!,
          montantTTC: item.montantTTC!,
          statut: "a_payer",
          etablissement: rid,
          note: `Reçue par mail${item.source?.from ? ` de ${item.source.from}` : ""}, validée automatiquement`.slice(0, 300),
          auto: true,
          inboxId: d.id,
          createdAt: now,
        });
        tx.update(d.ref, { statut: "valide", traiteLe: now, auto: true, factureId: invoiceRef.id, doutes: FieldValue.delete() });
        if (!fiche) suppliers.push({ id: supplierRef.id, nom: item.fournisseur.trim(), email });
        return true;
      })
      .catch((e) => {
        // 6 = ALREADY_EXISTS : la facture existe déjà (passage concurrent), rien à faire.
        if ((e as { code?: number }).code === 6) return false;
        throw e;
      });
    if (ok) {
      out.valides++;
      invoices.push({ supplierId: fiche?.id ?? "", nom, numero, date: item.dateFacture ?? "", ttc: item.montantTTC! });
    }
  }
  if (out.exemples?.length) console.log(`auto-validation ${rid} doutes:`, JSON.stringify(out.exemples));
  delete out.exemples;
  return out;
}
