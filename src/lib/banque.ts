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
 * Écarte les opérations déjà présentes via un import manuel (fichier du relevé) : même montant, date à 3 jours près
 * (le fichier peut porter la date d'opération, l'API la date comptable). Chaque ligne importée n'éteint qu'une opération.
 */
export function sansDoublonsImport<T extends { date: string; montant: number }>(
  lignes: T[],
  importees: { date: string; montant: number }[],
  toleranceJours = 3,
): T[] {
  const jour = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
  const stock = new Map<number, number[]>();
  for (const i of importees) stock.set(i.montant, [...(stock.get(i.montant) ?? []), jour(i.date)]);
  return lignes.filter((l) => {
    const dates = stock.get(l.montant);
    if (!dates?.length) return true;
    const d = jour(l.date);
    let best = -1;
    for (let k = 0; k < dates.length; k++) {
      const ecart = Math.abs(dates[k] - d);
      if (ecart <= toleranceJours && (best < 0 || ecart < Math.abs(dates[best] - d))) best = k;
    }
    if (best < 0) return true;
    dates.splice(best, 1);
    return false;
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

/**
 * Remet en forme une clé privée PEM collée dans Vercel : guillemets, « \n » littéraux, retours à la ligne
 * remplacés par des espaces, base64 du fichier entier ou corps base64 seul. Renvoie la cause si ce n'est pas une clé privée.
 */
export function normaliserPem(brut: string): { pem: string } | { erreur: string } {
  let s = brut.trim().replace(/^["']|["']$/g, "").replace(/\\r/g, "").replace(/\\n/g, "\n").trim();
  if (!s.includes("-----BEGIN")) {
    let decode = "";
    try {
      decode = atob(s.replace(/\s+/g, ""));
    } catch {
      /* pas du base64 */
    }
    if (decode.includes("-----BEGIN")) s = decode;
    else if (/^[A-Za-z0-9+/=\s]{200,}$/.test(s)) s = `-----BEGIN PRIVATE KEY-----\n${s}\n-----END PRIVATE KEY-----`;
    else return { erreur: "le texte collé ne contient pas « -----BEGIN … PRIVATE KEY----- » : colle le contenu du fichier .pem, pas son nom." };
  }
  const m = s.match(/-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/);
  if (!m) return { erreur: "la fin « -----END … PRIVATE KEY----- » manque : le texte a été coupé, recolle tout le fichier." };
  const type = m[1];
  if (!/PRIVATE KEY/.test(type)) return { erreur: `c'est un « ${type} », pas la clé privée : prends le fichier .pem téléchargé à la création de l'appli.` };
  const corps = m[2].replace(/[^A-Za-z0-9+/=]/g, "");
  if (corps.length < 200) return { erreur: "la clé est trop courte : le texte a été coupé, recolle tout le fichier." };
  const lignes = corps.match(/.{1,64}/g) ?? [];
  return { pem: `-----BEGIN ${type}-----\n${lignes.join("\n")}\n-----END ${type}-----\n` };
}

/**
 * RÈGLE DE SÉCURITÉ : l'app ne fait que LIRE les comptes. Seuls ces appels Enable Banking sont autorisés :
 * liste des banques, ouverture / fermeture d'un accès en lecture, lecture des opérations.
 * Tout le reste (paiements, virements, bénéficiaires…) est refusé avant même de partir vers l'API.
 */
const APPELS_LECTURE: { methode: string; chemin: RegExp }[] = [
  { methode: "GET", chemin: /^\/aspsps(\?[^/]*)?$/ },
  { methode: "POST", chemin: /^\/auth$/ },
  { methode: "POST", chemin: /^\/sessions$/ },
  { methode: "DELETE", chemin: /^\/sessions\/[A-Za-z0-9%._~-]+$/ },
  { methode: "GET", chemin: /^\/accounts\/[A-Za-z0-9%._~-]+\/transactions(\?[^/]*)?$/ },
];

export function appelLectureSeule(methode: string, chemin: string): boolean {
  const m = methode.toUpperCase();
  if (/payment|transfer|virement|beneficiar/i.test(chemin)) return false;
  return APPELS_LECTURE.some((a) => a.methode === m && a.chemin.test(chemin));
}
