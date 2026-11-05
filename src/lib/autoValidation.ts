import type { InboxFacture } from "./ingest";

/**
 * Validation automatique des factures lues par mail.
 * Une facture n'est enregistrée sans clic que si sa lecture est cohérente de bout en bout ;
 * sinon elle reste dans « À vérifier » avec la liste des doutes, affichée au gérant.
 */

export type Doute =
  | "incomplete"
  | "lecture"
  | "fournisseur_inconnu"
  | "sans_numero"
  | "sans_date"
  | "date_future"
  | "date_ancienne"
  | "montants_absents"
  | "avoir"
  | "montant_nul"
  | "calcul"
  | "taux_tva"
  | "doublon"
  | "montant_inhabituel"
  | "montant_eleve"
  | "type_document"
  | "autre_restaurant"
  | "mois_ancien"
  | "remise_a_verifier";

export const DOUTE_TEXTE: Record<Doute, string> = {
  incomplete: "Lecture incomplète : il manque le fournisseur, la date ou le montant.",
  lecture: "Le PDF n'a pas été lu correctement par l'IA.",
  fournisseur_inconnu: "Expéditeur qui n'est pas un fournisseur connu (ou mail transféré).",
  sans_numero: "Numéro de facture absent.",
  sans_date: "Date de facture absente.",
  date_future: "Date de facture dans le futur.",
  date_ancienne: "Date de facture plus de 2 mois avant le mail (jour et mois inversés ?).",
  montants_absents: "HT ou TVA non lus : impossible de contrôler le calcul.",
  avoir: "Avoir (montant négatif) : à confirmer.",
  montant_nul: "Montant à zéro.",
  calcul: "HT + TVA ne donne pas le TTC (consigne, acompte ou erreur de lecture ?).",
  taux_tva: "Taux de TVA anormal (au-delà de 20 %).",
  doublon: "Doublon possible : même numéro, ou même montant à quelques jours près, chez ce fournisseur.",
  montant_inhabituel: "Montant très supérieur aux factures habituelles de ce fournisseur.",
  montant_eleve: "Montant élevé pour un fournisseur encore peu connu (moins de 3 factures).",
  type_document: "Le mail ou le PDF parle d'avoir, relevé, bon de livraison, devis, duplicata ou relance.",
  autre_restaurant: "Le PDF semble adressé à l'autre restaurant.",
  mois_ancien: "Facture d'un mois déjà clôturé (avant le mois dernier).",
  remise_a_verifier: "Remise à vérifier à la main après une validation automatique.",
};

export interface ContexteValidation {
  /** Aujourd'hui, AAAA-MM-JJ (heure de Paris). */
  aujourdhui: string;
  /** Restaurant dans lequel la facture serait enregistrée. */
  restaurant: "19e" | "17e";
  /** Jour de réception du mail (AAAA-MM-JJ), sinon aujourd'hui. */
  recuLe?: string;
  /** L'expéditeur est un fournisseur connu (règles de tri ou e-mail de la fiche fournisseur). */
  fournisseurConnu: boolean;
  /** Même fournisseur et même numéro (ou même TTC à ±3 jours) déjà enregistré ou reçu. */
  doublon: boolean;
  /** TTC des factures déjà enregistrées pour ce fournisseur (centimes). */
  historiqueTTC: number[];
  /** Le gérant a remis cette ligne à vérifier après une validation automatique. */
  remiseAVerifier?: boolean;
}

const TOLERANCE_CALCUL = 2; // centimes d'arrondi
const TAUX_MAX = 0.205; // 20 % + marge d'arrondi
const JOURS_FUTUR = 2; // après la réception du mail
const JOURS_PASSE = 62; // avant la réception du mail
const FACTEUR_INHABITUEL = 3;
const HISTORIQUE_MIN = 3;
const PLAFOND_NOUVEAU = 200_000; // 2 000 € TTC tant que le fournisseur a moins de 3 factures

/** Pièces qui ne sont pas une facture à payer, ou qui le sont déjà. */
const MOTS_DOUTEUX =
  /(?<![\p{L}\d])(avoirs?|relev[ée]s?|r[ée]capitulatif|r[ée]cap|[ée]tat de compte|situation de compte|note de cr[ée]dit|bons? de (livraison|commande)|bl|pro ?forma|devis|duplicata|copie|relance|rappel|mise en demeure)(?![\p{L}\d])/iu;

/** Mois précédent AAAA-MM. */
function moisPrecedent(jour: string): string {
  const [y, m] = jour.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const jours = (a: string, b: string) => (Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;

/** Liste des doutes sur une facture lue ; vide = elle peut être validée toute seule. */
export function doutesFacture(item: InboxFacture, ctx: ContexteValidation): Doute[] {
  const d: Doute[] = [];
  if (ctx.remiseAVerifier) d.push("remise_a_verifier");
  if (item.incomplet) d.push("incomplete");
  if (item.lecture) d.push("lecture");
  if (!ctx.fournisseurConnu) d.push("fournisseur_inconnu");
  if (!item.numero?.trim()) d.push("sans_numero");

  const base = ctx.recuLe ?? ctx.aujourdhui;
  if (!item.dateFacture || !/^\d{4}-\d{2}-\d{2}$/.test(item.dateFacture)) d.push("sans_date");
  else if (jours(item.dateFacture, base) > JOURS_FUTUR || jours(item.dateFacture, ctx.aujourdhui) > JOURS_FUTUR) d.push("date_future");
  else if (jours(base, item.dateFacture) > JOURS_PASSE) d.push("date_ancienne");
  else if (item.dateFacture.slice(0, 7) < moisPrecedent(ctx.aujourdhui)) d.push("mois_ancien");

  const textes = [item.source.subject, item.source.attachment, item.numero].filter(Boolean).join(" ");
  if (MOTS_DOUTEUX.test(textes)) d.push("type_document");
  if (item.etablissementPdf && item.etablissementPdf !== ctx.restaurant) d.push("autre_restaurant");

  const { montantHT: ht, montantTVA: tva, montantTTC: ttc } = item;
  if (ht === undefined || tva === undefined || ttc === undefined) d.push("montants_absents");
  else {
    if (ttc < 0) d.push("avoir");
    else if (ttc === 0) d.push("montant_nul");
    if (Math.abs(ht + tva - ttc) > TOLERANCE_CALCUL) d.push("calcul");
    if (ttc > 0 && (tva < 0 || ht <= 0 || tva > ht * TAUX_MAX + TOLERANCE_CALCUL)) d.push("taux_tva");
    if (ttc > 0 && ctx.historiqueTTC.length >= HISTORIQUE_MIN && ttc > FACTEUR_INHABITUEL * Math.max(...ctx.historiqueTTC)) d.push("montant_inhabituel");
    if (ttc > PLAFOND_NOUVEAU && ctx.historiqueTTC.length < HISTORIQUE_MIN) d.push("montant_eleve");
  }
  if (ctx.doublon) d.push("doublon");
  return d;
}

/** Identifiant de la facture créée par la validation automatique : un même élément ne donne jamais deux factures. */
export const factureAutoId = (inboxId: string) => `mail-${inboxId}`.slice(0, 150);
