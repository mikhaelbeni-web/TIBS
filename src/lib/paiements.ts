import type { BankTransaction, Invoice, ModePaiement, Supplier, WithId } from "./types";

/**
 * Paiement des factures fournisseurs, regroupées par fournisseur et par mois :
 * - virement : un seul virement du total restant à payer ;
 * - prélèvement : le fournisseur prélève, on contrôle que le relevé bancaire correspond au total.
 */
export interface GroupeFournisseur {
  cle: string; // supplierId (ou nom si le fournisseur a été supprimé)
  nom: string;
  supplier?: WithId<Supplier>;
  mode: ModePaiement;
  factures: WithId<Invoice>[];
  total: number; // TTC de toutes les factures du mois (centimes)
  reste: number; // TTC des factures non payées
  litiges: number;
}

export function grouperParFournisseur(factures: WithId<Invoice>[], suppliers: WithId<Supplier>[]): GroupeFournisseur[] {
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const groupes = new Map<string, GroupeFournisseur>();
  for (const f of factures) {
    const s = byId.get(f.supplierId);
    const cle = s ? s.id : `nom:${f.supplierNom.toLowerCase()}`;
    let g = groupes.get(cle);
    if (!g) {
      g = { cle, nom: s?.nom ?? f.supplierNom, supplier: s, mode: s?.paiement ?? "virement", factures: [], total: 0, reste: 0, litiges: 0 };
      groupes.set(cle, g);
    }
    g.factures.push(f);
    g.total += f.montantTTC;
    if (f.statut === "a_payer") g.reste += f.montantTTC;
    if (f.statut === "litige") g.litiges++;
  }
  for (const g of groupes.values()) g.factures.sort((a, b) => a.dateFacture.localeCompare(b.dateFacture));
  // Ce qui reste à faire d'abord, puis les plus gros montants.
  return [...groupes.values()].sort((a, b) => Number(b.reste > 0) - Number(a.reste > 0) || b.total - a.total);
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

const FORMES = new Set(["SAS", "SASU", "SARL", "EURL", "SA", "SNC", "STE", "SOCIETE", "ETS", "ETABLISSEMENTS", "LES", "DES", "DE", "LA", "LE", "ET", "FRANCE", "DISTRIBUTION"]);

/** Mots à chercher dans le libellé bancaire : réglage du fournisseur, sinon les mots distinctifs de son nom. */
export function motsBanque(nom: string, libelleBanque?: string): string[] {
  if (libelleBanque?.trim()) return libelleBanque.split(/[,;\n]/).map(norm).filter(Boolean);
  const mots = norm(nom).split(" ").filter((m) => m.length >= 3 && !FORMES.has(m));
  return mots.length ? [mots.join(" ")] : [norm(nom)];
}

/** Dernier jour du mois suivant (un prélèvement d'octobre peut passer début novembre). */
function finFenetre(mois: string): string {
  const [y, m] = mois.split("-").map(Number);
  const d = new Date(Date.UTC(y, m + 1, 0)); // jour 0 du mois m+2 = dernier jour du mois m+1
  return d.toISOString().slice(0, 10);
}

export interface ControlePrelevement {
  lignes: WithId<BankTransaction>[];
  preleve: number; // centimes, positif
  ecart: number; // prélevé - attendu
  etat: "ok" | "ecart" | "absent";
}

/** Débits du relevé qui correspondent au fournisseur, du 1er du mois à la fin du mois suivant. */
export function controlerPrelevement(
  g: Pick<GroupeFournisseur, "nom" | "supplier" | "total">,
  mois: string,
  banque: WithId<BankTransaction>[],
  tolerance = 100,
): ControlePrelevement {
  const mots = motsBanque(g.nom, g.supplier?.libelleBanque);
  const debut = `${mois}-01`;
  const fin = finFenetre(mois);
  const lignes = banque.filter((t) => t.montant < 0 && t.date >= debut && t.date <= fin && mots.some((m) => norm(t.libelle).includes(m)));
  const preleve = lignes.reduce((s, t) => s - t.montant, 0);
  const ecart = preleve - g.total;
  return { lignes, preleve, ecart, etat: !lignes.length ? "absent" : Math.abs(ecart) <= tolerance ? "ok" : "ecart" };
}

/** Libellé à mettre sur le virement : « Factures 10/2026 FAC-1 FAC-2 » (limité à 140 caractères, norme SEPA). */
export function referenceVirement(mois: string, factures: Pick<Invoice, "numero" | "statut">[]): string {
  const [y, m] = mois.split("-");
  const nums = factures.filter((f) => f.statut === "a_payer" && f.numero).map((f) => f.numero);
  return `Factures ${m}/${y}${nums.length ? ` ${nums.join(" ")}` : ""}`.slice(0, 140);
}

/** Les virements fournisseurs d'un mois se font le 15 du mois suivant. */
export function echeanceVirement(mois: string): string {
  const [y, m] = mois.split("-").map(Number);
  return new Date(Date.UTC(y, m, 15)).toISOString().slice(0, 10);
}
