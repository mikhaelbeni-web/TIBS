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
