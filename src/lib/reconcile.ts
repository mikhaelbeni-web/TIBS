import { daysBetween } from "./money";

export interface CashLine {
  id: string;
  date: string; // jour du Z de caisse
  amount: number; // centimes attendus en banque (ex. total CB)
}

export interface BankLine {
  id: string;
  date: string;
  amount: number; // centimes, crédit positif
  libelle: string;
}

export interface MatchOptions {
  /** Délai max entre le Z et le crédit bancaire (remises CB : J+1 à J+3 en général). */
  maxDays: number;
  /** Commission bancaire max tolérée, en fraction (0.03 = 3 %). */
  maxFeeRate: number;
  /** Écart absolu toléré au-dessus du montant de caisse, en centimes (arrondis). */
  tolerance: number;
}

export const DEFAULT_OPTIONS: MatchOptions = { maxDays: 5, maxFeeRate: 0.03, tolerance: 1 };

export interface ProposedMatch {
  cash: CashLine;
  bank: BankLine;
  ecart: number; // banque - caisse (négatif = commission)
  days: number;
}

export interface ReconcileResult {
  matches: ProposedMatch[];
  unmatchedCash: CashLine[];
  unmatchedBank: BankLine[];
}

/**
 * Associe chaque ligne de caisse à au plus un crédit bancaire, et inversement.
 * Candidats : crédit reçu entre 0 et maxDays jours après le Z, montant compris entre
 * caisse × (1 - maxFeeRate) et caisse + tolerance. On retient d'abord les paires les plus proches
 * (écart relatif puis délai), ce qui évite qu'une remise mal placée « vole » la bonne.
 */
export function reconcile(
  cash: CashLine[],
  bank: BankLine[],
  options: MatchOptions = DEFAULT_OPTIONS,
): ReconcileResult {
  const candidates: (ProposedMatch & { score: number })[] = [];
  for (const c of cash) {
    if (c.amount <= 0) continue;
    for (const b of bank) {
      if (b.amount <= 0) continue;
      const days = daysBetween(c.date, b.date);
      if (days < 0 || days > options.maxDays) continue;
      const ecart = b.amount - c.amount;
      if (ecart > options.tolerance) continue;
      if (b.amount < Math.floor(c.amount * (1 - options.maxFeeRate))) continue;
      const score = Math.abs(ecart) / c.amount + days * 0.001;
      candidates.push({ cash: c, bank: b, ecart, days, score });
    }
  }
  candidates.sort((x, y) => x.score - y.score);

  const usedCash = new Set<string>();
  const usedBank = new Set<string>();
  const matches: ProposedMatch[] = [];
  for (const c of candidates) {
    if (usedCash.has(c.cash.id) || usedBank.has(c.bank.id)) continue;
    usedCash.add(c.cash.id);
    usedBank.add(c.bank.id);
    matches.push({ cash: c.cash, bank: c.bank, ecart: c.ecart, days: c.days });
  }
  matches.sort((a, b) => a.cash.date.localeCompare(b.cash.date));

  return {
    matches,
    unmatchedCash: cash.filter((c) => !usedCash.has(c.id) && c.amount > 0),
    unmatchedBank: bank.filter((b) => !usedBank.has(b.id) && b.amount > 0),
  };
}

export interface DepositMatch {
  deposit: BankLine;
  days: CashLine[]; // jours de caisse couverts par ce dépôt
  ecart: number; // dépôt - somme des jours
}

export interface DepositResult {
  matches: DepositMatch[];
  unmatchedDays: CashLine[];
  unmatchedDeposits: BankLine[];
}

/**
 * Espèces : un dépôt en banque couvre souvent plusieurs jours consécutifs.
 * Pour chaque dépôt (du plus ancien au plus récent), on cherche une suite de jours de caisse
 * consécutifs non encore couverts, tous antérieurs ou égaux au dépôt et au plus `maxDays` avant,
 * dont le total est égal au dépôt à `tolerance` centimes près.
 */
export function reconcileDeposits(
  days: CashLine[],
  deposits: BankLine[],
  { maxDays = 14, tolerance = 0 }: { maxDays?: number; tolerance?: number } = {},
): DepositResult {
  const sortedDays = days.filter((d) => d.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  const used = new Set<string>();
  const matches: DepositMatch[] = [];
  const unmatchedDeposits: BankLine[] = [];

  for (const dep of [...deposits].filter((d) => d.amount > 0).sort((a, b) => a.date.localeCompare(b.date))) {
    const eligible = sortedDays.filter((d) => {
      const delta = daysBetween(d.date, dep.date);
      return !used.has(d.id) && delta >= 0 && delta <= maxDays;
    });
    let found: CashLine[] | null = null;
    // Fenêtres consécutives, en commençant par les plus anciennes (on dépose d'abord le plus vieux).
    outer: for (let i = 0; i < eligible.length; i++) {
      let sum = 0;
      for (let j = i; j < eligible.length; j++) {
        sum += eligible[j].amount;
        if (Math.abs(sum - dep.amount) <= tolerance) {
          found = eligible.slice(i, j + 1);
          break outer;
        }
        if (sum > dep.amount + tolerance) break;
      }
    }
    if (!found) {
      unmatchedDeposits.push(dep);
      continue;
    }
    found.forEach((d) => used.add(d.id));
    matches.push({ deposit: dep, days: found, ecart: dep.amount - found.reduce((s, d) => s + d.amount, 0) });
  }
  return { matches, unmatchedDays: sortedDays.filter((d) => !used.has(d.id)), unmatchedDeposits };
}
