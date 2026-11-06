import { compterValeurs } from "./banque";
import type { BankLine, CashLine } from "./reconcile";
import { comparerCB } from "./ticketZ";

export interface BilanRegle {
  /** Groupes de crédit (une journée, ou samedi + dimanche) rapprochés. */
  groupes: number;
  /** Écart de 1 € au plus. */
  exacts: number;
  /** Moins en banque qu'en caisse. */
  negatifs: number;
  /** Plus en banque qu'en caisse : un lot rattaché à la mauvaise journée. */
  positifs: number;
  /** Journées sans remise trouvée (relevé pas encore à jour). */
  sansCredit: number;
}

export interface BilanMoisCB {
  jours: number;
  avecValeur: BilanRegle;
  sansValeur: BilanRegle;
  remises: ReturnType<typeof compterValeurs>;
}

function compter(mois: string, cash: CashLine[], lignes: BankLine[], today: string): BilanRegle {
  const credits = lignes.filter((b) => b.amount > 0);
  const vus = new Set<string>();
  const t: BilanRegle = { groupes: 0, exacts: 0, negatifs: 0, positifs: 0, sansCredit: 0 };
  for (const c of cash) {
    if (!c.date.startsWith(mois) || c.amount <= 0) continue;
    const r = comparerCB(c.date, cash, credits, { lignes, today });
    if (!r.banque || r.ecart === undefined) {
      t.sansCredit++;
      continue;
    }
    if (vus.has(r.banque.date)) continue;
    vus.add(r.banque.date);
    t.groupes++;
    if (Math.abs(r.ecart) <= 100) t.exacts++;
    else if (r.ecart > 0) t.positifs++;
    else t.negatifs++;
  }
  return t;
}

/**
 * Contrôle d'un mois sur les vraies données, en compteurs seulement (aucun montant) : la règle avec date de valeur
 * contre la même règle sans elle. Octobre 2026 (relevé Caisse d'Épargne) : 9 groupes exacts et 0 positif avec la date
 * de valeur, 1 exact et 7 positifs sans.
 */
export function bilanCB(mois: string, cash: CashLine[], lignes: BankLine[], today = new Date().toISOString().slice(0, 10)): BilanMoisCB {
  const sans = lignes.map((b) => ({ id: b.id, date: b.date, amount: b.amount, libelle: b.libelle }));
  return {
    jours: cash.filter((c) => c.date.startsWith(mois) && c.amount > 0).length,
    avecValeur: compter(mois, cash, lignes, today),
    sansValeur: compter(mois, cash, sans, today),
    remises: compterValeurs(lignes.filter((b) => b.date.startsWith(mois)).map((b) => ({ date: b.date, montant: b.amount, libelle: b.libelle, valeur: b.valeur }))),
  };
}
