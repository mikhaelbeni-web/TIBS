import type { CashEntry, Invoice } from "./types";

export const TAUX = [
  { key: "ttc55", label: "5,5 %", rate: 0.055 },
  { key: "ttc10", label: "10 %", rate: 0.1 },
  { key: "ttc20", label: "20 %", rate: 0.2 },
] as const;

export interface TvaLigne {
  label: string;
  rate: number;
  ttc: number;
  ht: number;
  tva: number;
}

export interface TvaReport {
  collectee: TvaLigne[];
  totalCollectee: number;
  /** Encaissements sans ventilation par taux : à ventiler avant envoi. */
  nonVentile: { jours: string[]; montant: number };
  deductible: number;
  facturesHT: number;
  nbFactures: number;
  net: number; // > 0 : TVA à payer ; < 0 : crédit de TVA
}

/** TVA d'un montant TTC : TTC - TTC / (1 + taux), arrondi au centime. */
export function tvaFromTtc(ttc: number, rate: number): number {
  return ttc - Math.round(ttc / (1 + rate));
}

/**
 * TVA collectée sur les ventes de la période (journées de caisse ventilées par taux)
 * et TVA déductible sur les factures fournisseurs datées dans la période.
 * Bornes incluses, au format AAAA-MM-JJ.
 */
export function tvaReport(cash: CashEntry[], invoices: Invoice[], from: string, to: string): TvaReport {
  const days = cash.filter((c) => c.date >= from && c.date <= to);
  const collectee = TAUX.map(({ key, label, rate }) => {
    const ttc = days.reduce((s, d) => s + (d[key] ?? 0), 0);
    const tva = tvaFromTtc(ttc, rate);
    return { label, rate, ttc, ht: ttc - tva, tva };
  });
  const sansVentilation = days.filter((d) => !d.ttc55 && !d.ttc10 && !d.ttc20 && d.cb + d.especes + d.ticketsResto + d.autres > 0);
  const inv = invoices.filter((i) => i.dateFacture >= from && i.dateFacture <= to);
  const totalCollectee = collectee.reduce((s, l) => s + l.tva, 0);
  const deductible = inv.reduce((s, i) => s + i.montantTVA, 0);
  return {
    collectee,
    totalCollectee,
    nonVentile: {
      jours: sansVentilation.map((d) => d.date),
      montant: sansVentilation.reduce((s, d) => s + d.cb + d.especes + d.ticketsResto + d.autres, 0),
    },
    deductible,
    facturesHT: inv.reduce((s, i) => s + i.montantHT, 0),
    nbFactures: inv.length,
    net: totalCollectee - deductible,
  };
}

/** Jour du mois où la TVA du mois précédent part chez le comptable. */
export const JOUR_ENVOI_TVA = 10;

/** Date limite d'envoi de la TVA d'un mois (AAAA-MM) : le 10 du mois suivant. */
export function echeanceDuMois(mois: string, jour = JOUR_ENVOI_TVA): string {
  const [y, m] = mois.split("-").map(Number);
  return new Date(Date.UTC(y, m, jour)).toISOString().slice(0, 10);
}

export interface EcheanceTva {
  mois: string; // AAAA-MM déclaré
  date: string; // AAAA-MM-JJ limite d'envoi
  joursRestants: number;
}

/**
 * Prochaine échéance d'envoi au comptable : le 10 du mois suivant la période.
 * Jusqu'au 10 inclus, on est encore sur le mois précédent ; après, sur le mois en cours.
 */
export function prochaineEcheanceTva(today: string, jour = JOUR_ENVOI_TVA): EcheanceTva {
  const [y, m, d] = today.split("-").map(Number);
  // Mois de l'échéance (1-12) : celui-ci si on n'a pas dépassé le jour, sinon le suivant.
  const dueIdx = d <= jour ? m - 1 : m; // index 0-based, peut valoir 12
  const due = new Date(Date.UTC(y, dueIdx, jour));
  const period = new Date(Date.UTC(y, dueIdx - 1, 1));
  const date = due.toISOString().slice(0, 10);
  return {
    mois: period.toISOString().slice(0, 7),
    date,
    joursRestants: Math.round((Date.parse(date) - Date.parse(today)) / 86400000),
  };
}
