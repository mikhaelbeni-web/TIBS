/**
 * Relevé bancaire automatique (accès DSP2 en lecture seule via Enable Banking).
 * Fonctions pures : conversion des opérations de l'API en lignes bankTransactions, dédoublonnage, échéances.
 */

/** Opération telle que renvoyée par GET /accounts/{uid}/transactions (champs utiles). */
export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount?: { amount?: string | number; currency?: string } | null;
  credit_debit_indicator?: "CRDT" | "DBIT" | string | null;
  status?: string | null;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
  bank_transaction_code?: { description?: string | null } | null;
}

export interface LigneBanque {
  date: string; // AAAA-MM-JJ
  libelle: string;
  montant: number; // centimes, positif = crédit
  /** Référence de l'opération chez la banque (sert d'identifiant stable). */
  ref: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}/;

/** Convertit un montant texte de l'API (« 123.45 ») en centimes, sans erreur d'arrondi. */
export function centimes(v: string | number | undefined | null): number | null {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim().replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [ent, dec = ""] = s.replace("-", "").split(".");
  const c = Number(ent) * 100 + Number((dec + "00").slice(0, 2));
  return neg ? -c : c;
}

/** Ligne de relevé à partir d'une opération de l'API. Seules les opérations comptabilisées (BOOK) sont gardées. */
export function versLigne(t: EbTransaction): Omit<LigneBanque, "ref"> & { ref?: string } | null {
  if (t.status && t.status !== "BOOK") return null;
  const brut = centimes(t.transaction_amount?.amount);
  if (brut === null) return null;
  const date = [t.booking_date, t.value_date, t.transaction_date].find((d) => d && ISO.test(d))?.slice(0, 10);
  if (!date) return null;
  const abs = Math.abs(brut);
  const montant = t.credit_debit_indicator === "DBIT" ? -abs : t.credit_debit_indicator === "CRDT" ? abs : brut;
  const contrepartie = montant < 0 ? t.creditor?.name : t.debtor?.name;
  const libelle =
    (t.remittance_information ?? []).map((s) => s.trim()).filter(Boolean).join(" ").replace(/\s+/g, " ") ||
    contrepartie?.trim() ||
    t.bank_transaction_code?.description?.trim() ||
    "Opération";
  const ref = t.entry_reference || t.transaction_id || undefined;
  return { date, libelle, montant, ref: ref ?? undefined };
}

/** Empreinte courte et stable (deux hachages 32 bits FNV-1a et djb2, en base 36), pour fabriquer des identifiants de document. */
export function empreinte(s: string): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (const ch of new TextEncoder().encode(s)) {
    a = Math.imul(a ^ ch, 0x01000193) >>> 0;
    b = (Math.imul(b, 33) + ch) >>> 0;
  }
  return a.toString(36) + b.toString(36);
}

/**
 * Convertit une page d'opérations d'un compte en lignes avec identifiant stable.
 * Sans référence banque, l'identifiant combine date, montant, libellé et rang (deux cafés identiques le même jour restent deux lignes).
 */
export function lignesDuCompte(compte: string, txs: EbTransaction[]): (LigneBanque & { id: string })[] {
  const vus = new Map<string, number>();
  const out: (LigneBanque & { id: string })[] = [];
  for (const t of txs) {
    const l = versLigne(t);
    if (!l) continue;
    let ref = l.ref;
    if (!ref) {
      const cle = `${l.date}|${l.montant}|${l.libelle}`;
      const n = vus.get(cle) ?? 0;
      vus.set(cle, n + 1);
      ref = `${cle}|${n}`;
    }
    out.push({ ...l, ref, id: `eb_${l.date}_${empreinte(`${compte}|${ref}`)}` });
  }
  return out;
}

/**
 * Écarte les opérations déjà présentes via un import manuel (fichier du relevé) : même date et même montant.
 * Chaque ligne importée n'éteint qu'une seule opération de l'API.
 */
export function sansDoublonsImport<T extends { date: string; montant: number }>(
  lignes: T[],
  importees: { date: string; montant: number }[],
): T[] {
  const stock = new Map<string, number>();
  for (const i of importees) stock.set(`${i.date}|${i.montant}`, (stock.get(`${i.date}|${i.montant}`) ?? 0) + 1);
  return lignes.filter((l) => {
    const k = `${l.date}|${l.montant}`;
    const n = stock.get(k) ?? 0;
    if (n > 0) {
      stock.set(k, n - 1);
      return false;
    }
    return true;
  });
}

const JOUR = 86_400_000;

/** Date de début du relevé : 5 jours avant la dernière opération connue (opérations tardives), 90 jours au premier passage. */
export function debutReleve(derniereDate: string | undefined, now = Date.now()): string {
  const min = new Date(now - 90 * JOUR).toISOString().slice(0, 10);
  if (!derniereDate) return min;
  const d = new Date(Date.parse(`${derniereDate}T00:00:00Z`) - 5 * JOUR).toISOString().slice(0, 10);
  return d < min ? min : d;
}

/** Intervalle minimal entre deux relevés automatiques (la DSP2 limite à 4 accès par jour sans l'utilisateur). */
export const INTERVALLE_RELEVE = 8 * 3600_000;

export function releveBanqueDu(dernierPassage: number | undefined, now = Date.now()): boolean {
  return !dernierPassage || now - dernierPassage >= INTERVALLE_RELEVE;
}

/** Jours restants avant la fin de l'autorisation (négatif = expirée). */
export function joursRestants(validUntil: string | undefined, now = Date.now()): number | null {
  if (!validUntil) return null;
  const t = Date.parse(validUntil);
  return Number.isNaN(t) ? null : Math.floor((t - now) / JOUR);
}

/** Banques proposées en premier dans la liste (celles des restaurants). */
export function trierBanques<T extends { name: string }>(banques: T[]): T[] {
  const score = (n: string) => (/caisse d.?epargne|caisse d.?épargne/i.test(n) ? (/ile.de.france|île.de.france/i.test(n) ? 0 : 1) : 2);
  return [...banques].sort((a, b) => score(a.name) - score(b.name) || a.name.localeCompare(b.name, "fr"));
}
