import type { Invoice, WithId } from "./types";

/**
 * Relevés fournisseurs (restaurants/{rid}/releves/{id}) : document de contrôle envoyé par certains
 * fournisseurs, qui liste les factures et avoirs d'une période. Jamais transformé en facture.
 */
export interface ReleveLigne {
  numero: string;
  date?: string;
  montantTTC: number; // centimes, négatif pour un avoir
}

export interface Releve {
  fournisseur: string;
  supplierId?: string;
  numero?: string;
  dateReleve?: string;
  periodeDebut?: string;
  periodeFin?: string;
  mois: string; // AAAA-MM de la fin de période
  totalTTC?: number;
  soldeAnterieur?: number;
  netAPayer?: number;
  compteClient?: string;
  lignes: ReleveLigne[];
  /** Somme des lignes = total imprimé (sinon la lecture est à vérifier, aucun montant n'est proposé). */
  coherent: boolean;
  /** Écarts clos à la main : clé de l'écart → note. */
  justifies?: Record<string, string>;
  source: { messageId: string; boite?: string; attachment?: string; from?: string; subject?: string };
  createdAt: number;
}

export const normNumero = (s: string) =>
  s
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^(FACTURE|FACT|FAC|FA|AVOIR|AV|N)(?=\d)/, "")
    .replace(/^0+(?=\d)/, "");

export const sommeLignes = (l: ReleveLigne[]) => l.reduce((t, x) => t + x.montantTTC, 0);

export function estCoherent(r: Pick<Releve, "lignes" | "totalTTC">, tolerance = 100): boolean {
  return r.totalTTC !== undefined && r.lignes.length > 0 && Math.abs(sommeLignes(r.lignes) - r.totalTTC) <= tolerance;
}

export type EtatLigne =
  | { etat: "ok"; ligne: ReleveLigne; facture: WithId<Invoice>; horsPeriode: boolean }
  | { etat: "montant"; ligne: ReleveLigne; facture: WithId<Invoice> }
  | { etat: "probable"; ligne: ReleveLigne; facture: WithId<Invoice> }
  | { etat: "en_attente"; ligne: ReleveLigne } // reçue par mail, encore dans « À vérifier »
  | { etat: "non_recue"; ligne: ReleveLigne };

export interface Rapprochement {
  lignes: EtatLigne[];
  /** Factures de la période absentes du relevé. */
  absentes: WithId<Invoice>[];
  totalReleve: number;
  totalFactures: number;
  ecarts: number; // nombre d'écarts non justifiés
  /** Montant à payer proposé : net du relevé si tout est justifié, sinon factures validées. */
  aPayer: number;
  base: "releve" | "factures";
}

export const cleEcart = (type: string, numero: string) => `${type}:${normNumero(numero)}`;

const jours = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

/**
 * Rapprochement dans les deux sens. `factures` = factures du fournisseur sur la période élargie
 * (mois précédent → mois suivant) ; `enAttente` = numéros encore dans « À vérifier ».
 */
export function rapprocher(r: Releve, factures: WithId<Invoice>[], enAttente: string[] = []): Rapprochement {
  const debut = r.periodeDebut ?? `${r.mois}-01`;
  const fin = r.periodeFin ?? `${r.mois}-31`;
  const dansPeriode = (f: Invoice) => f.dateFacture >= debut && f.dateFacture <= fin;
  const libres = new Set(factures.map((f) => f.id));
  const parNumero = new Map<string, WithId<Invoice>>();
  for (const f of factures) if (f.numero) parNumero.set(normNumero(f.numero), f);
  const attente = new Set(enAttente.map(normNumero));
  const justifies = r.justifies ?? {};

  const lignes: EtatLigne[] = r.lignes.map((ligne) => {
    const f = parNumero.get(normNumero(ligne.numero));
    if (f && libres.has(f.id)) {
      libres.delete(f.id);
      if (Math.abs(f.montantTTC - ligne.montantTTC) > 1) return { etat: "montant", ligne, facture: f };
      return { etat: "ok", ligne, facture: f, horsPeriode: !dansPeriode(f) };
    }
    return { etat: "non_recue", ligne };
  });
  // Sans numéro reconnu : même montant à ±3 jours = correspondance probable (à confirmer, jamais validée seule).
  for (const [i, l] of lignes.entries()) {
    if (l.etat !== "non_recue") continue;
    if (attente.has(normNumero(l.ligne.numero))) {
      lignes[i] = { etat: "en_attente", ligne: l.ligne };
      continue;
    }
    const f = factures.find(
      (x) => libres.has(x.id) && Math.abs(x.montantTTC - l.ligne.montantTTC) <= 1 && (!l.ligne.date || jours(x.dateFacture, l.ligne.date) <= 3),
    );
    if (f) {
      libres.delete(f.id);
      lignes[i] = { etat: "probable", ligne: l.ligne, facture: f };
    }
  }
  const absentes = factures.filter((f) => libres.has(f.id) && dansPeriode(f));

  const ecarts =
    lignes.filter((l) => l.etat !== "ok" && !justifies[cleEcart("ligne", l.ligne.numero)]).length +
    absentes.filter((f) => !justifies[cleEcart("facture", f.numero || f.id)]).length;
  const totalReleve = r.totalTTC ?? sommeLignes(r.lignes);
  const validees = lignes.filter((l) => l.etat === "ok" || l.etat === "montant" || l.etat === "probable").map((l) => (l as { facture: WithId<Invoice> }).facture);
  const totalFactures = [...validees, ...absentes].filter((f) => f.statut !== "payee").reduce((t, f) => t + f.montantTTC, 0);
  const toutJustifie = r.coherent && ecarts === 0;
  return {
    lignes,
    absentes,
    totalReleve,
    totalFactures,
    ecarts,
    aPayer: toutJustifie ? (r.netAPayer ?? totalReleve) : totalFactures,
    base: toutJustifie ? "releve" : "factures",
  };
}

/** Clé de document : fournisseur + n° de relevé (un relevé corrigé remplace l'ancien). */
export function releveDocId(fournisseur: string, numero: string | undefined, repli: string): string {
  const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${slug(fournisseur) || "x"}_${slug(numero || repli) || "x"}`;
}
