import { compterValeurs } from "./banque";
import { isCashDeposit, isUber } from "./cashImport";
import type { BankLine, CashLine } from "./reconcile";
import { comparerCB, deduireValeurs, estRemiseCB, estVirementTitres, lotDuMatinPossible, pointageMoisCB, type ComparaisonCB } from "./ticketZ";

export interface BilanRegle {
  /** Groupes de crédit (une journée, ou samedi + dimanche) rapprochés. */
  groupes: number;
  /** Écart de 1 € au plus. */
  exacts: number;
  /** Petit manque en banque : titres-restaurant passés en CB (payés à part par les émetteurs). */
  titres: number;
  /** Moins en banque qu'en caisse, au-delà des titres-restaurant. */
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
    /** Crédits du mois par famille, en nombre de lignes : où peut passer la CB qui manque. */
    familles: Record<Famille, number>;
    /**
     * Hypothèse « carte titre-restaurant ou Amex passée au TPE et saisie CB en caisse » : rapport, arrondi à 0,05, entre
     * leurs virements et le manque CB (petits écarts négatifs, jusqu'à 200 €). Proche de 1 sur plusieurs mois = cause trouvée.
     * « decale » : virements reçus 7 jours plus tard que les crédits CB comparés (paiement à la semaine).
     */
    manque: {
      tr: number | null;
      trDecale: number | null;
      amex: number | null;
      amexDecale: number | null;
      /** Idem sans les titres-restaurant des commandes Uber Eats (récaps du mail), versés eux aussi à part par les émetteurs. */
      trHorsUber: number | null;
      trHorsUberDecale: number | null;
      semainesUberAvecTitres: number;
    };
    /**
     * Manque CB en % de la CB de caisse (arrondi à 0,1), par jour de service, sur les crédits à moins de 200 € d'écart.
     * Les cartes titre-restaurant ne passent pas le dimanche et peu le samedi : un manque bien plus faible le week-end
     * désigne les titres-restaurant ; un manque égal tous les jours, une autre cause (paiements refusés, frais…).
     */
    parJour: Record<string, { credits: number; pourcent: number }>;
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

export type Famille = "cb" | "uber" | "especes" | "tr" | "amex" | "stripe" | "autre";
const AMEX = /AMERICAN\s*EXPRESS|\bAMEX\b/i;
function famille(b: BankLine): Famille {
  if (estRemiseCB(b)) return "cb";
  if (isUber(b.libelle)) return "uber";
  if (estVirementTitres(b.libelle)) return "tr";
  if (AMEX.test(b.libelle)) return "amex";
  if (/STRIPE/i.test(b.libelle)) return "stripe";
  if (isCashDeposit(b.libelle)) return "especes";
  return "autre";
}
const decale = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const rapport = (a: number, b: number) => (b > 0 ? Math.round((20 * a) / b) / 20 : null);

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
  const t: BilanRegle = { groupes: 0, exacts: 0, titres: 0, negatifs: 0, positifs: 0, sansCredit: 0 };
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
    else if (r.titres) t.titres++;
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
export function bilanCB(
  mois: string,
  cash: CashLine[],
  lignes: BankLine[],
  today = new Date().toISOString().slice(0, 10),
  /** Titres-restaurant des récaps Uber Eats, datés du dernier jour de la semaine. */
  titresUber: { fin: string; montant: number }[] = [],
): BilanMoisCB {
  const sans = lignes.map((b) => ({ id: b.id, date: b.date, amount: b.amount, libelle: b.libelle }));
  const credits = sans.filter((b) => b.amount > 0);
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
      // Remises rattachées à aucune journée, y compris celles des 10 jours d'avant le mois (fin du mois précédent).
      creditsSansCaisse: [...new Set(pointageMoisCB(mois, cash, credits, { lignes: sans, today }).remisesSeules.map((b) => deduites.get(b.id) ?? b.date))].sort(),
      familles: credits.filter(duMois).reduce(
        (o, b) => ((o[famille(b)] += 1), o),
        { cb: 0, uber: 0, especes: 0, tr: 0, amex: 0, stripe: 0, autre: 0 } as Record<Famille, number>,
      ),
      parJour: (() => {
        const noms = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
        const t: Record<string, { credits: number; caisse: number; ecart: number }> = {};
        for (const g of ecarts) {
          const e = g.ecart ?? 0;
          if (!g.joursCouverts?.length || Math.abs(e) > 20000 || g.caisse <= 0) continue;
          const j = g.joursCouverts.map((c) => new Date(`${c.date}T00:00:00Z`).getUTCDay());
          const cle = j.every((x) => x === 0 || x === 6) ? "we" : j.length === 1 ? noms[j[0]] : "melange";
          const v = (t[cle] ??= { credits: 0, caisse: 0, ecart: 0 });
          v.credits++;
          v.caisse += g.caisse;
          v.ecart += e;
        }
        return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, { credits: v.credits, pourcent: Math.round((1000 * v.ecart) / v.caisse) / 10 }]));
      })(),
      manque: (() => {
        const petit = -ecarts.reduce((t, g) => t + ((g.ecart ?? 0) < -100 && (g.ecart ?? 0) >= -20000 ? (g.ecart ?? 0) : 0), 0);
        const somme = (f: Famille, de: string, a: string) => credits.filter((b) => b.date >= de && b.date <= a && famille(b) === f).reduce((t, b) => t + b.amount, 0);
        const fin = `${mois}-31`;
        const uber = (de: string, a: string) => titresUber.filter((t) => t.fin >= de && t.fin <= a).reduce((x, t) => x + t.montant, 0);
        const [d7, f7] = [decale(`${mois}-01`, 7), decale(joursDuMois(mois).at(-1)!, 7)];
        return {
          trHorsUber: rapport(somme("tr", `${mois}-01`, fin) - uber(`${mois}-01`, fin), petit),
          trHorsUberDecale: rapport(somme("tr", d7, f7) - uber(`${mois}-01`, fin), petit),
          semainesUberAvecTitres: titresUber.filter((t) => t.fin.startsWith(mois)).length,
          tr: rapport(somme("tr", `${mois}-01`, fin), petit),
          trDecale: rapport(somme("tr", d7, f7), petit),
          amex: rapport(somme("amex", `${mois}-01`, fin), petit),
          amexDecale: rapport(somme("amex", decale(`${mois}-01`, 7), decale(joursDuMois(mois).at(-1)!, 7)), petit),
        };
      })(),
    },
    remises: compterValeurs(lignes.filter(duMois).map((b) => ({ date: b.date, montant: b.amount, libelle: b.libelle, valeur: b.valeur }))),
  };
}
