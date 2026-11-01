/**
 * Réglages par restaurant (stockés dans restaurants/{rid}/settings/mail.reglages, écrits par le serveur).
 * Partagé entre la page Réglages et le relevé des mails.
 */
export type ModeleIA = "opus" | "sonnet" | "haiku";

/** Tarifs Anthropic en dollars par million de jetons (entrée / sortie). */
export const MODELES: Record<ModeleIA, { id: string; nom: string; detail: string; entree: number; sortie: number }> = {
  opus: { id: "claude-opus-5-5", nom: "Opus 5.5", detail: "le plus précis", entree: 4, sortie: 20 },
  sonnet: { id: "claude-sonnet-5-5", nom: "Sonnet 5.5", detail: "équilibré", entree: 2, sortie: 10 },
  haiku: { id: "claude-haiku-5-5", nom: "Haiku 5.5", detail: "le moins cher", entree: 0.1, sortie: 0.5 },
};

/** Jetons typiques pour une facture d'une à deux pages (estimation affichée avant la première lecture). */
export const JETONS_FACTURE_TYPE = { entree: 5_000, sortie: 1_500 };

export interface Reglages {
  /** Lire les PDF avec Claude (sinon les montants sont à saisir). */
  lecturePdf: boolean;
  modele: ModeleIA;
  /** Au-delà, plus aucune lecture ce mois-ci (les éléments arrivent « à compléter »). 0 = pas de limite. */
  budgetMensuelUsd: number;
  /** Nombre maximum de PDF lus par vérification (bouton ou relevé du matin). */
  maxLecturesParVerification: number;
  /** Relevé automatique. */
  releveAuto: boolean;
  /** Intervalle entre deux relevés automatiques, en heures. */
  frequenceHeures: number;
  /** Jours relus au premier relevé (et au maximum ensuite). */
  joursPremierReleve: number;
}

export const DEFAULT_REGLAGES: Reglages = {
  lecturePdf: true,
  modele: "opus",
  budgetMensuelUsd: 15,
  maxLecturesParVerification: 40,
  releveAuto: true,
  frequenceHeures: 24,
  joursPremierReleve: 31,
};

/** Intervalles proposés (le réveil automatique passe toutes les heures). */
export const FREQUENCES = [1, 2, 3, 4, 6, 8, 12, 24] as const;

const clamp = (v: unknown, min: number, max: number, d: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

/** Valeurs stockées → réglages complets et bornés (une saisie farfelue ne casse rien). */
export function parseReglages(raw: unknown): Reglages {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    lecturePdf: typeof r.lecturePdf === "boolean" ? r.lecturePdf : DEFAULT_REGLAGES.lecturePdf,
    modele: r.modele === "opus" || r.modele === "sonnet" || r.modele === "haiku" ? r.modele : DEFAULT_REGLAGES.modele,
    budgetMensuelUsd: Math.round(clamp(r.budgetMensuelUsd, 0, 1000, DEFAULT_REGLAGES.budgetMensuelUsd) * 100) / 100,
    maxLecturesParVerification: Math.round(clamp(r.maxLecturesParVerification, 1, 500, DEFAULT_REGLAGES.maxLecturesParVerification)),
    releveAuto: typeof r.releveAuto === "boolean" ? r.releveAuto : DEFAULT_REGLAGES.releveAuto,
    frequenceHeures: (FREQUENCES as readonly number[]).includes(Number(r.frequenceHeures)) ? Number(r.frequenceHeures) : DEFAULT_REGLAGES.frequenceHeures,
    joursPremierReleve: Math.round(clamp(r.joursPremierReleve, 1, 90, DEFAULT_REGLAGES.joursPremierReleve)),
  };
}

/** Coût en dollars d'un appel. */
export const coutUsd = (modele: ModeleIA, entree: number, sortie: number) =>
  (entree * MODELES[modele].entree + sortie * MODELES[modele].sortie) / 1_000_000;

/** Mois en cours à Paris, « AAAA-MM ». */
export const moisCle = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }).slice(0, 7);

export interface Consommation {
  lectures: number;
  entree: number;
  sortie: number;
  coutUsd: number;
}

export function parseConsommation(raw: unknown): Consommation {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return { lectures: n(r.lectures), entree: n(r.entree), sortie: n(r.sortie), coutUsd: n(r.coutUsd) };
}

/**
 * Le relevé automatique doit-il passer maintenant ? Marge de 10 minutes pour que le réveil horaire,
 * jamais pile à l'heure, ne saute pas un tour.
 */
export function releveDu(reglages: Reglages, dernierPassage: number | undefined, now = Date.now()): boolean {
  if (!reglages.releveAuto) return false;
  if (!dernierPassage) return true;
  return now - dernierPassage >= reglages.frequenceHeures * 3_600_000 - 10 * 60_000;
}
