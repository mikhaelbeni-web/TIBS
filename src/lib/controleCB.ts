import { compterValeurs } from "./banque";
import type { BankLine, CashLine } from "./reconcile";
import { comparerCB, deduireValeurs, estRemiseCB, lotDuMatinPossible, type ComparaisonCB } from "./ticketZ";

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
  /** Dates de valeur de la banque (relevé en fichier), rien de déduit. */
  avecValeur: BilanRegle;
  /** Sans date de valeur, lots du matin retrouvés par les montants. */
  deduite: BilanRegle;
  /** Sans date de valeur ni déduction : chaque remise compte à son jour de crédit. */
  sansValeur: BilanRegle;
  /** Lots du mois qui peuvent être du matin, et ceux que le calcul rattache à la veille. */
  lots: { possibles: number; deduits: number };
  /**
   * Pour chercher un écart qui revient chaque jour, sans montant : nombre de lignes de frais « CB COM » du mois, et
   * répartition des écarts de la règle déduite par tranche d'euros et par tranche de pourcentage de la CB en caisse.
   */
  diagnostic: {
    fraisCB: number;
    euros: Record<string, number>;
    pourcents: Record<string, number>;
    anomalies: Anomalie[];
    /** Jours du mois sans journée de caisse (fermeture, ou journée pas relevée dans L'Addition). */
    joursSansCaisse: string[];
    /** Jours de crédit du mois dont les remises ne couvrent aucune journée de caisse : elles ne sont comparées à rien. */
    creditsSansCaisse: string[];
  };
  remises: ReturnType<typeof compterValeurs>;
}

/** Un crédit avec plus de 200 € d'écart, décrit sans montant : ce qui permet d'en deviner la cause. */
export interface Anomalie {
  credit: string;
  sens: "+" | "-";
  taille: "200-500" | "500+";
  /** Journées de caisse couvertes, et jours du calendrier sans journée de caisse dans la même période. */
  jours: number;
  joursSansCaisse: number;
  remises: number;
  lotsZero: number;
  lotsDeduits: number;
  /** Le crédit voisin a un écart de sens contraire qui l'annule à 10 % près : lot rattaché au mauvais crédit. */
  voisinOppose?: "avant" | "apres";
  /** L'écart vaut, à 1 % près, la CB d'une des journées couvertes (journée sans remise, ou en trop). */
  egalJournee?: boolean;
  /** L'écart vaut, à 1 € près, une remise de ce crédit ou du suivant. */
  egalRemise?: boolean;
  /** Premier crédit du relevé : les remises d'avant manquent peut-être. */
  premierCredit?: boolean;
}

function joursDuMois(mois: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${mois}-01T00:00:00Z`); d.toISOString().startsWith(mois); d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
  return out;
}

function anomalies(groupes: ComparaisonCB[], lignes: BankLine[]): Anomalie[] {
  const tries = [...groupes].sort((a, b) => (a.banque?.date ?? "").localeCompare(b.banque?.date ?? ""));
  const premier = lignes.filter(estRemiseCB).reduce((m, b) => (b.date < m ? b.date : m), "9999");
  const out: Anomalie[] = [];
  tries.forEach((g, i) => {
    const e = g.ecart ?? 0;
    if (!g.banque || Math.abs(e) <= 20000) return;
    const jours = g.joursCouverts ?? [];
    const debut = jours[0]?.date ?? g.banque.date;
    const calendrier = Math.round((Date.parse(g.banque.date) - Date.parse(debut)) / 86400000);
    const oppose = (v?: ComparaisonCB) => !!v && Math.sign(v.ecart ?? 0) === -Math.sign(e) && Math.abs(e + (v.ecart ?? 0)) <= Math.abs(e) / 10;
    const suivant = tries[i + 1];
    out.push({
      credit: g.banque.date,
      sens: e > 0 ? "+" : "-",
      taille: Math.abs(e) > 50000 ? "500+" : "200-500",
      jours: jours.length,
      joursSansCaisse: Math.max(0, calendrier - jours.length),
      remises: g.remises?.length ?? 0,
      lotsZero: (g.remises ?? []).filter((b) => lotDuMatinPossible({ ...b, valeur: undefined })).length,
      lotsDeduits: (g.remises ?? []).filter((b) => b.valeurDeduite).length,
      ...(oppose(tries[i - 1]) ? { voisinOppose: "avant" as const } : oppose(suivant) ? { voisinOppose: "apres" as const } : {}),
      ...(jours.some((j) => Math.abs(j.amount - Math.abs(e)) <= j.amount / 100) ? { egalJournee: true } : {}),
      ...([...(g.remises ?? []), ...(suivant?.remises ?? [])].some((b) => Math.abs(b.amount - Math.abs(e)) <= 100) ? { egalRemise: true } : {}),
      ...(g.banque.date <= premier || (g.remises ?? []).some((b) => b.date === premier) ? { premierCredit: true } : {}),
    });
  });
  return out;
}

const TRANCHES_EUROS = [1, 20, 50, 100, 200, 500];
const TRANCHES_POURCENTS = [0.5, 1, 2, 3, 5, 10];
/** « -50 » : écart négatif de 20 à 50 € ; « +inf » : au-delà de la dernière tranche. */
const tranche = (v: number, bornes: number[]) => {
  const b = bornes.find((x) => Math.abs(v) <= x);
  return b === bornes[0] ? `${b}` : `${v < 0 ? "-" : "+"}${b ?? "inf"}`;
};

function compter(
  mois: string,
  cash: CashLine[],
  lignes: BankLine[],
  today: string,
  deduire: boolean,
  ecarts: ComparaisonCB[] = [],
): BilanRegle {
  const credits = lignes.filter((b) => b.amount > 0);
  const vus = new Set<string>();
  const t: BilanRegle = { groupes: 0, exacts: 0, negatifs: 0, positifs: 0, sansCredit: 0 };
  for (const c of cash) {
    if (!c.date.startsWith(mois) || c.amount <= 0) continue;
    const r = comparerCB(c.date, cash, credits, { lignes, today, deduire });
    if (!r.banque || r.ecart === undefined) {
      t.sansCredit++;
      continue;
    }
    if (vus.has(r.banque.date)) continue;
    vus.add(r.banque.date);
    t.groupes++;
    ecarts.push(r);
    if (Math.abs(r.ecart) <= 100) t.exacts++;
    else if (r.ecart > 0) t.positifs++;
    else t.negatifs++;
  }
  return t;
}

/**
 * Contrôle d'un mois sur les vraies données, en compteurs seulement (aucun montant) : la règle avec les dates de valeur
 * de la banque, la même règle avec les lots du matin déduits des montants, et sans rien. Octobre 2026 (relevé Caisse
 * d'Épargne) : 9 groupes exacts et 0 positif avec la date de valeur comme en la déduisant, 1 exact et 7 positifs sans.
 */
export function bilanCB(mois: string, cash: CashLine[], lignes: BankLine[], today = new Date().toISOString().slice(0, 10)): BilanMoisCB {
  const sans = lignes.map((b) => ({ id: b.id, date: b.date, amount: b.amount, libelle: b.libelle }));
  const remises = sans.filter(estRemiseCB);
  const deduites = deduireValeurs(cash, remises);
  const duMois = (b: BankLine) => b.date.startsWith(mois);
  const ecarts: ComparaisonCB[] = [];
  const compte = (cles: string[]) => cles.reduce<Record<string, number>>((o, k) => ((o[k] = (o[k] ?? 0) + 1), o), {});
  const deduite = compter(mois, cash, sans, today, true, ecarts);
  return {
    jours: cash.filter((c) => c.date.startsWith(mois) && c.amount > 0).length,
    avecValeur: compter(mois, cash, lignes, today, false),
    deduite,
    sansValeur: compter(mois, cash, sans, today, false),
    lots: { possibles: remises.filter((b) => duMois(b) && lotDuMatinPossible(b)).length, deduits: remises.filter((b) => duMois(b) && deduites.has(b.id)).length },
    diagnostic: {
      fraisCB: lignes.filter((b) => duMois(b) && b.amount < 0 && /\bCB\s*COM\b/i.test(b.libelle)).length,
      euros: compte(ecarts.map((e) => tranche((e.ecart ?? 0) / 100, TRANCHES_EUROS))),
      pourcents: compte(ecarts.filter((e) => e.caisse > 0).map((e) => tranche((100 * (e.ecart ?? 0)) / e.caisse, TRANCHES_POURCENTS))),
      anomalies: anomalies(ecarts, sans),
      joursSansCaisse: joursDuMois(mois).filter((j) => j < today && !cash.some((c) => c.date === j && c.amount > 0)),
      creditsSansCaisse: [...new Set(remises.filter(duMois).map((b) => deduites.get(b.id) ?? b.date))]
        .filter((d) => !ecarts.some((g) => g.banque?.date === d))
        .sort(),
    },
    remises: compterValeurs(lignes.filter(duMois).map((b) => ({ date: b.date, montant: b.amount, libelle: b.libelle, valeur: b.valeur }))),
  };
}
