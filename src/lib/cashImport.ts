import { normalizeHeader, type Row } from "./importer";
import { toCents, toIsoDate } from "./money";

export interface CashDraft {
  date: string;
  cb: number;
  especes: number;
  ticketsResto: number;
  autres: number;
  ttc55: number;
  ttc10: number;
  ttc20: number;
}

function pick(row: Row, aliases: string[]): unknown {
  for (const a of aliases) {
    const v = row[normalizeHeader(a)];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/**
 * Format générique en attendant l'export TD collecte réel :
 * une ligne par jour, colonnes Date / CB / Espèces / Tickets resto / Autres,
 * et si possible les ventes TTC par taux : TTC 5,5 / TTC 10 / TTC 20.
 * Plusieurs lignes du même jour (ex. un ticket par ligne) sont additionnées.
 */
export function rowsToCash(rows: Row[]): CashDraft[] {
  const byDay = new Map<string, CashDraft>();
  for (const row of rows) {
    const date = toIsoDate(pick(row, ["date", "jour", "date de caisse", "date z"]));
    if (!date) continue;
    const d = byDay.get(date) ?? { date, cb: 0, especes: 0, ticketsResto: 0, autres: 0, ttc55: 0, ttc10: 0, ttc20: 0 };
    d.cb += toCents(pick(row, ["cb", "carte", "carte bancaire", "carte bleue"])) ?? 0;
    d.especes += toCents(pick(row, ["especes", "espèces", "cash", "liquide"])) ?? 0;
    d.ticketsResto += toCents(pick(row, ["tickets resto", "ticket restaurant", "titres restaurant", "tr"])) ?? 0;
    d.autres += toCents(pick(row, ["autres", "autre", "cheque", "chèque"])) ?? 0;
    d.ttc55 += toCents(pick(row, ["ttc 5,5", "ttc 5.5", "ventes 5,5", "tva 5,5", "5,5%", "5,5"])) ?? 0;
    d.ttc10 += toCents(pick(row, ["ttc 10", "ventes 10", "tva 10", "10%"])) ?? 0;
    d.ttc20 += toCents(pick(row, ["ttc 20", "ventes 20", "tva 20", "20%"])) ?? 0;
    byDay.set(date, d);
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Libellé bancaire qui ressemble à un dépôt d'espèces. */
export function isCashDeposit(libelle: string): boolean {
  return /esp|versement|vrst|depot|dépôt|remise.*billet/i.test(libelle);
}

/** Identifiant stable d'une ligne de relevé : réimporter le même relevé ne crée pas de doublon. */
export function bankDocId(date: string, montant: number, libelle: string, occurrence: number): string {
  const slug = normalizeHeader(libelle).slice(0, 40) || "x";
  return `${date}_${montant}_${slug}_${occurrence}`;
}

/** Virement Uber Eats sur le relevé bancaire. */
export function isUber(libelle: string): boolean {
  return /uber/i.test(libelle);
}

export interface UberDraft {
  date: string;
  montant: number;
  brut?: number;
  frais?: number;
  reference?: string;
}

/**
 * Format générique en attendant l'export réel du Manager Uber Eats :
 * Date du versement ; Montant net ; (Ventes) ; (Frais Uber) ; (Référence).
 */
export function rowToUber(row: Row): UberDraft | null {
  const date = toIsoDate(pick(row, ["date du versement", "date de versement", "date de paiement", "date du virement", "payout date", "date"]));
  const montant = toCents(pick(row, ["montant net", "versement", "montant du versement", "montant du virement", "net payout", "total payout", "montant"]));
  if (!date || montant === null) return null;
  const brut = toCents(pick(row, ["ventes", "total des ventes", "ventes ttc", "sales", "gross sales"]));
  const frais = toCents(pick(row, ["frais uber", "frais", "commission", "uber fee", "marketplace fee"]));
  const ref = pick(row, ["reference", "référence", "id du versement", "payout id", "id"]);
  return {
    date,
    montant,
    ...(brut !== null ? { brut } : {}),
    ...(frais !== null ? { frais: Math.abs(frais) } : {}),
    ...(ref !== undefined ? { reference: String(ref).trim() } : {}),
  };
}
