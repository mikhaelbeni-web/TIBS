import { daysBetween } from "./money";
import { reconcile, type BankLine, type CashLine } from "./reconcile";

/**
 * Ticket Z de L'Addition (Comptabilité > CA/TVA > Paiement > Jour à jour > Ticket Z).
 * Le Z est imprimé à la fermeture des caisses : un Z daté du 05/11 avec une clôture à 00:53
 * correspond à la journée de service du 04/11.
 */

export type Categorie = "cb" | "especes" | "uber" | "ticketsResto" | "autres";

export interface LignePaiement {
  libelle: string;
  montant: number; // centimes
  categorie: Categorie;
  /** Nombre d'opérations imprimé à côté (ex. « x25 » = 25 commandes Uber), si présent. */
  nombre?: number;
}

export interface TicketZ {
  /** Date imprimée en haut du ticket (AAAA-MM-JJ). */
  dateTicket: string;
  /** Heure de fermeture des caisses (HH:MM), si lisible. */
  heureCloture?: string;
  paiements: LignePaiement[];
  /** Total imprimé sur le ticket (centimes), si lisible. */
  total?: number;
  ttc55?: number;
  ttc10?: number;
  ttc20?: number;
}

/** Avant cette heure, une clôture appartient à la journée de la veille. */
export const HEURE_BASCULE = 6;

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** Journée de service couverte par un Z, d'après sa date et son heure de clôture. */
export function jourDuTicket(dateTicket: string, heureCloture?: string): string {
  const h = heureCloture?.match(/^(\d{1,2})[:hH](\d{2})/);
  if (h && Number(h[1]) < HEURE_BASCULE) return addDays(dateTicket, -1);
  return dateTicket;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** Range un moyen de paiement du Z dans une catégorie de rapprochement. */
export function categorie(libelle: string): Categorie {
  const s = norm(libelle);
  if (/uber/.test(s)) return "uber";
  if (/esp|cash|liquide/.test(s)) return "especes";
  if (/ticket|titre|swile|edenred|sodexo|pluxee|up dej|cheque dej|chq dej|apetiz|bimpli|resto|\btr\b/.test(s)) return "ticketsResto";
  if (/\bcb\b|carte|visa|mastercard|master card|amex|american|tpe|cbc|sans contact|contactless/.test(s)) return "cb";
  return "autres";
}

export interface Totaux {
  /** Nombre de commandes Uber (somme des « xN » des lignes Uber). */
  uberCommandes: number;
  cb: number;
  especes: number;
  uber: number;
  ticketsResto: number;
  autres: number;
  somme: number;
}

export function totaux(paiements: LignePaiement[]): Totaux {
  const t: Totaux = { uberCommandes: 0, cb: 0, especes: 0, uber: 0, ticketsResto: 0, autres: 0, somme: 0 };
  for (const p of paiements) {
    t[p.categorie] += p.montant;
    if (p.categorie === "uber") t.uberCommandes += p.nombre ?? 0;
    t.somme += p.montant;
  }
  return t;
}

/** proche : petit écart explicable (commandes Uber entre minuit et la fermeture, comptées dans une autre semaine). */
export type Statut = "ok" | "proche" | "ecart" | "attente" | "absent";

export interface ComparaisonCB {
  statut: Statut;
  /** CB en caisse comparée : la journée choisie, plus les autres journées créditées le même jour (week-end). */
  caisse: number;
  banque?: { date: string; montant: number; libelle: string; jours: number };
  ecart?: number; // banque - caisse (négatif = commission)
  /** Remises CB créditées le premier jour bancaire après la journée de service. */
  remises?: BankLine[];
  /** Journées de caisse couvertes par ces remises (samedi soir + dimanche → lundi). */
  joursCouverts?: CashLine[];
  /** Un paiement est passé sur le jour voisin : les deux écarts se compensent. */
  voisin?: { credit: string; ecart: number };
  /** Écart cumulé du mois, remises par jour de crédit contre CB des journées couvertes. */
  cumul?: { depuis: string; caisse: number; banque: number; ecart: number };
  /** Crédits bancaires des jours suivants, pour vérifier à l'œil quand rien n'est rapproché. */
  candidats: BankLine[];
}

const REMISE = /\bCB\b(?!\s*COM)\D*?\d{6}\b/i;

/** Remise CB d'un TPE (« CB TIB S 021126 CONTRAT 806056 »), hors frais « CB COM ». */
export const estRemiseCB = (b: BankLine) => b.amount > 0 && REMISE.test(b.libelle);

interface GroupeCB {
  /** Jour où la banque crédite les remises. */
  credit: string;
  remises: BankLine[];
  banque: number;
  jours: CashLine[];
  caisse: number;
}

/**
 * Les paiements CB d'une journée de service sont crédités le premier jour bancaire qui suit
 * (le TPE les envoie la nuit ; samedi soir et dimanche arrivent le lundi). La date écrite dans le
 * libellé (« 021126 ») est celle de l'envoi : une remise « 021126 » peut contenir le dimanche 01/11.
 * Vérifié sur octobre 2026 : par jour de crédit, écart de 0 à 270 € ; par date de libellé, jusqu'à 4 000 €.
 */
function groupesCB(joursCaisse: CashLine[], remises: BankLine[], maxDays: number): GroupeCB[] {
  const credits = [...new Set(remises.map((b) => b.date))].sort();
  return credits.map((credit, i) => {
    const plancher = addDays(credit, -maxDays);
    const debut = i > 0 && credits[i - 1] > plancher ? credits[i - 1] : plancher;
    const rs = remises.filter((b) => b.date === credit);
    const jours = joursCaisse.filter((c) => c.amount > 0 && c.date >= debut && c.date < credit).sort((a, b) => a.date.localeCompare(b.date));
    return { credit, remises: rs, banque: rs.reduce((t, b) => t + b.amount, 0), jours, caisse: jours.reduce((t, c) => t + c.amount, 0) };
  });
}

const TOLERANCE_CB = 100; // centimes

function parCredit(
  jour: string,
  joursCaisse: CashLine[],
  remises: BankLine[],
  maxDays: number,
): Omit<ComparaisonCB, "candidats"> | null {
  const groupes = groupesCB(joursCaisse, remises, maxDays);
  const i = groupes.findIndex((g) => g.jours.some((c) => c.date === jour));
  if (i < 0) return null;
  const g = groupes[i];
  const ecart = g.banque - g.caisse;
  let statut: Statut = Math.abs(ecart) <= TOLERANCE_CB ? "ok" : "ecart";
  let voisin: ComparaisonCB["voisin"];
  if (statut === "ecart") {
    for (const v of [groupes[i - 1], groupes[i + 1]]) {
      if (!v || !v.caisse) continue;
      const ev = v.banque - v.caisse;
      if (Math.abs(ecart + ev) <= TOLERANCE_CB) {
        statut = "proche";
        voisin = { credit: v.credit, ecart: ev };
        break;
      }
    }
  }
  const mois = jour.slice(0, 7);
  const duMois = groupes.slice(0, i + 1).filter((x) => x.caisse > 0 && x.jours.every((c) => c.date.startsWith(mois)));
  const cumul = duMois.length
    ? (() => {
        const caisse = duMois.reduce((t, x) => t + x.caisse, 0);
        const banque = duMois.reduce((t, x) => t + x.banque, 0);
        return { depuis: duMois[0].jours[0].date, caisse, banque, ecart: banque - caisse };
      })()
    : undefined;
  return {
    statut,
    caisse: g.caisse,
    banque: { date: g.credit, montant: g.banque, libelle: g.remises.map((b) => b.libelle).join(" + "), jours: daysBetween(jour, g.credit) },
    ecart,
    remises: g.remises,
    joursCouverts: g.jours,
    ...(voisin ? { voisin } : {}),
    ...(cumul ? { cumul } : {}),
  };
}

export function comparerCB(
  jour: string,
  joursCaisse: CashLine[],
  credits: BankLine[],
  {
    maxDays = 5,
    maxFeeRate = 0.03,
    today = new Date().toISOString().slice(0, 10),
    /** Toutes les lignes (débits compris) pour reconnaître les remises par leur libellé. */
    lignes = credits,
  }: { maxDays?: number; maxFeeRate?: number; today?: string; lignes?: BankLine[] } = {},
): ComparaisonCB {
  const caisse = joursCaisse.find((c) => c.date === jour)?.amount ?? 0;
  // 1) Remises CB reconnues au libellé : regroupées par jour de crédit, montant brut.
  const remises = lignes.filter(estRemiseCB);
  if (caisse > 0 && remises.length) {
    const r = parCredit(jour, joursCaisse, remises, maxDays);
    if (r) return { ...r, candidats: [] };
  }
  const candidats = credits
    .filter((b) => {
      const d = daysBetween(jour, b.date);
      return d >= 0 && d <= maxDays;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
  if (caisse <= 0) return { statut: "absent", caisse, candidats };
  if (remises.length) {
    // Format Caisse d'Épargne reconnu mais aucune remise créditée après ce jour : relevé pas encore à jour, ou remise manquante.
    const derniere = lignes.reduce((m, b) => (b.date > m ? b.date : m), "");
    return { statut: derniere <= jour || daysBetween(jour, today) <= 3 ? "attente" : "ecart", caisse, candidats };
  }
  const fenetre = joursCaisse.filter((c) => Math.abs(daysBetween(jour, c.date)) <= 10);
  const banque = credits.filter((b) => {
    const d = daysBetween(jour, b.date);
    return d >= -10 && d <= maxDays + 10;
  });
  const r = reconcile(fenetre, banque, { maxDays, maxFeeRate, tolerance: 1 });
  const m = r.matches.find((x) => x.cash.date === jour);
  if (!m) {
    return { statut: daysBetween(jour, today) <= 3 ? "attente" : "ecart", caisse, candidats };
  }
  return {
    statut: "ok",
    caisse,
    banque: { date: m.bank.date, montant: m.bank.amount, libelle: m.bank.libelle, jours: m.days },
    ecart: m.ecart,
    candidats,
  };
}

/** Semaine de versement Uber (lundi → dimanche) contenant le jour. */
export function semaineUber(jour: string): { debut: string; fin: string } {
  const dow = (new Date(`${jour}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = lundi
  const debut = addDays(jour, -dow);
  return { debut, fin: addDays(debut, 6) };
}

export interface VersementUber {
  id: string;
  date: string;
  montant: number;
  brut?: number;
  frais?: number;
  reference?: string;
  /** Période couverte par le récap Uber (mail du lundi), si connue. */
  debut?: string;
  fin?: string;
}

export interface ComparaisonUber {
  statut: Statut;
  caisseJour: number;
  semaine: { debut: string; fin: string };
  /** Somme des montants Uber des Z de la semaine. */
  caisseSemaine: number;
  joursSaisis: number;
  versement?: VersementUber;
  /** Ventes Uber de la semaine (brut du versement) - Uber des Z. */
  ecart?: number;
}

/**
 * Uber Eats verse une fois par semaine (récap du lundi) : on compare les ventes brutes du versement
 * avec la somme des montants Uber des Z de la semaine du jour choisi.
 */
export function comparerUber(
  jour: string,
  ubersCaisse: CashLine[],
  versements: VersementUber[],
  { today = new Date().toISOString().slice(0, 10), tolerance = 100, tauxProche = 0.03 } = {},
): ComparaisonUber {
  // Le récap Uber donne sa période : on prend celle qui contient le jour, sinon la semaine lundi → dimanche.
  const parPeriode = versements.find((v) => v.debut && v.fin && v.debut <= jour && jour <= v.fin);
  const semaine = parPeriode ? { debut: parPeriode.debut!, fin: parPeriode.fin! } : semaineUber(jour);
  const dansSemaine = ubersCaisse.filter((c) => c.date >= semaine.debut && c.date <= semaine.fin);
  const caisseSemaine = dansSemaine.reduce((s, c) => s + c.amount, 0);
  const caisseJour = ubersCaisse.find((c) => c.date === jour)?.amount ?? 0;
  // Versement de cette semaine : versé dans les 10 jours qui suivent le dimanche.
  const versement = parPeriode ?? versements
    .filter((v) => !v.debut || !v.fin)
    .filter((v) => {
      const d = daysBetween(semaine.fin, v.date);
      return d >= 0 && d <= 10;
    })
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const base = { caisseJour, semaine, caisseSemaine, joursSaisis: dansSemaine.length };
  if (!versement) {
    return { ...base, statut: daysBetween(semaine.fin, today) <= 8 ? "attente" : caisseSemaine ? "ecart" : "absent" };
  }
  if (versement.brut === undefined) return { ...base, versement, statut: "attente" };
  const ecart = versement.brut - caisseSemaine;
  const complet = dansSemaine.length === 7;
  // Uber coupe sa semaine à lundi 00:00 alors que le Z du dimanche garde les commandes jusqu'à la
  // fermeture (~1 h) : quelques commandes changent de semaine, d'où un petit écart attendu.
  const statut: Statut = !complet
    ? "ecart"
    : Math.abs(ecart) <= tolerance
      ? "ok"
      : Math.abs(ecart) <= Math.max(tolerance, caisseSemaine * tauxProche)
        ? "proche"
        : "ecart";
  return { ...base, versement, ecart, statut };
}

export interface ComparaisonUberBanque {
  statut: Statut;
  virement?: BankLine & { jours: number };
}

/**
 * Troisième côté de la triangulation Uber : le net annoncé par le mail Uber doit arriver tel quel
 * sur le compte (virement « UBER », entre J-2 et J+5 de la date du versement).
 */
export function comparerUberBanque(
  versement: VersementUber | undefined,
  virementsUber: BankLine[],
  { today = new Date().toISOString().slice(0, 10) } = {},
): ComparaisonUberBanque {
  if (!versement) return { statut: "absent" };
  const candidats = virementsUber
    .map((b) => ({ ...b, jours: daysBetween(versement.date, b.date) }))
    .filter((b) => b.jours >= -2 && b.jours <= 5 && Math.abs(b.amount - versement.montant) <= 1)
    .sort((a, b) => Math.abs(a.jours) - Math.abs(b.jours));
  if (candidats[0]) return { statut: "ok", virement: candidats[0] };
  return { statut: daysBetween(versement.date, today) <= 5 ? "attente" : "ecart" };
}

/** Le pire statut l'emporte (un seul écart suffit à alerter). */
export function pire(...s: Statut[]): Statut {
  for (const x of ["ecart", "proche", "attente", "absent", "ok"] as Statut[]) if (s.includes(x)) return x;
  return "absent";
}

/** Le total imprimé correspond-il à la somme des moyens de paiement ? */
export function controleTotal(t: TicketZ): { statut: Statut; somme: number; total?: number; ecart?: number } {
  const somme = totaux(t.paiements).somme;
  if (t.total === undefined) return { statut: "absent", somme };
  const ecart = somme - t.total;
  return { statut: Math.abs(ecart) <= 1 ? "ok" : "ecart", somme, total: t.total, ecart };
}

/** Ventes Uber Eats d'une journée, d'après le Manager Uber Eats (uberJours/{AAAA-MM-JJ}). */
export interface UberJour {
  date: string;
  commandes: number;
  ventes: number; // centimes TTC
}

export interface ComparaisonUberJour {
  statut: Statut;
  caisse: { commandes?: number; montant: number };
  uber?: UberJour;
  ecartCommandes?: number; // Uber - caisse
  ecartMontant?: number; // Uber - caisse, centimes
}

/**
 * Uber du jour : le Z indique « Uber x25 … 901,00 € ». Uber doit montrer, pour la même journée,
 * le même nombre de commandes et le même montant (à 1 € près pour les arrondis).
 */
export function comparerUberJour(
  caisse: { commandes?: number; montant: number },
  uber: UberJour | undefined,
  { tolerance = 100 } = {},
): ComparaisonUberJour {
  if (!uber) return { statut: caisse.montant ? "attente" : "absent", caisse };
  const ecartMontant = uber.ventes - caisse.montant;
  const ecartCommandes = caisse.commandes === undefined ? undefined : uber.commandes - caisse.commandes;
  const ok = Math.abs(ecartMontant) <= tolerance && (ecartCommandes === undefined || ecartCommandes === 0);
  return { statut: ok ? "ok" : "ecart", caisse, uber, ecartCommandes, ecartMontant };
}

/** Seuls les liens de ticket Z de L'Addition (colonne URL de l'export « Détails par service ») sont suivis. */
export function urlZAutorisee(u: unknown): URL | null {
  if (typeof u !== "string" || u.length > 2000) return null;
  try {
    const url = new URL(u);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" && url.hostname === "data.laddition.com" && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}
