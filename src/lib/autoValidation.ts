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
  lecture: "PDF pas encore lu par l'IA (limite, budget ou erreur) : il sera relu au prochain passage, ou touche « Lire ce PDF avec l'IA ».",
  fournisseur_inconnu: "Le fournisseur lu sur le PDF n'apparaît pas dans le mail (mail transféré ou expéditeur inconnu).",
  sans_numero: "Numéro de facture absent.",
  sans_date: "Date de facture absente.",
  date_future: "Date de facture dans le futur.",
  date_ancienne: "Date de facture douteuse : jour et mois peut-être inversés, ou plus d'un an avant le mail.",
  montants_absents: "HT ou TVA non lus : impossible de contrôler le calcul.",
  avoir: "Avoir d'un nouveau fournisseur, ou plus gros que ses factures habituelles : à confirmer.",
  montant_nul: "Montant à zéro.",
  calcul: "HT + TVA s'écarte du TTC de plus de 2 € (acompte ou erreur de lecture ?).",
  taux_tva: "Taux de TVA anormal (au-delà de 20 %).",
  doublon: "Doublon possible : même numéro, ou même montant à quelques jours près, chez ce fournisseur.",
  montant_inhabituel: "Montant très supérieur aux factures habituelles de ce fournisseur.",
  montant_eleve: "Première facture d'un nouveau fournisseur, au-dessus de 5 000 €.",
  type_document: "Le mail parle de relevé, bon de livraison, devis, duplicata ou relance, ou d'avoir alors que le montant lu est positif.",
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
  /** L'expéditeur est un fournisseur connu (règles de tri, e-mail de la fiche, ou nom du PDF présent dans le mail). */
  fournisseurConnu: boolean;
  /** Reconnu seulement par son nom dans le mail, sans fiche ni facture : plafond pour la première facture. */
  fournisseurNouveau?: boolean;
  /** Même fournisseur et même numéro (ou même TTC à ±3 jours) déjà enregistré ou reçu. */
  doublon: boolean;
  /** TTC des factures déjà enregistrées pour ce fournisseur (centimes). */
  historiqueTTC: number[];
  /** Le gérant a remis cette ligne à vérifier après une validation automatique. */
  remiseAVerifier?: boolean;
}

const TOLERANCE_CALCUL = 2; // centimes d'arrondi
const ECART_MAX = 200; // 2 € de consigne / frais hors TVA
const TAUX_MAX = 0.205; // 20 % + marge d'arrondi
const JOURS_FUTUR = 2; // après la réception du mail
const JOURS_PASSE = 62; // avant la réception du mail
const FACTEUR_INHABITUEL = 3;
const HISTORIQUE_MIN = 3;
const PLAFOND_NOUVEAU = 500_000; // 5 000 € TTC pour la toute première facture d'un fournisseur reconnu par son seul nom

/** Pièces qui ne sont pas une facture à payer, ou qui le sont déjà. */
const MOTS_DOUTEUX =
  /(?<![\p{L}\d])(relev[ée]s?|r[ée]capitulatif|r[ée]cap|[ée]tat de compte|situation de compte|bons? de (livraison|commande)|bl|pro ?forma|devis|duplicata|copie|relance|rappel|mise en demeure)(?![\p{L}\d])/iu;

const plier = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
/** Mots trop courants pour identifier un fournisseur. */
const MOTS_GENERIQUES = new Set(
  "sarl sas sasu eurl snc sci societe ste france paris facture factures distribution distributions groupe services service compagnie restaurant restauration ava tibs".split(" "),
);

/**
 * Le nom du fournisseur lu sur le PDF figure aussi dans le mail (nom ou adresse de l'expéditeur, objet,
 * nom du PDF) : mail et facture désignent le même fournisseur, même si l'adresse n'est pas encore connue.
 * Ex. « SARL POISSONNERIE AZUELOS » ↔ « Patrick AZUELOS <poissonneriefinedefrance@gmail.com> ».
 */
export function nomDansLeMail(fournisseur: string, mail: { from?: string; subject?: string; attachment?: string }): boolean {
  const texte = plier([mail.from, mail.subject, mail.attachment].filter(Boolean).join(" "));
  const mots = plier(fournisseur)
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length >= 4 && !MOTS_GENERIQUES.has(m));
  return mots.some((m) => texte.includes(m));
}

/** Avoir annoncé dans l'objet, le nom du PDF ou le numéro. */
const MOTS_AVOIR = /(?<![\p{L}\d])(avoirs?|note de cr[ée]dit|av\d+)(?![\p{L}])/iu;

/**
 * Date bien antérieure au mail : normal pour une facture envoyée en retard ou une reprise depuis janvier.
 * Douteuse seulement si jour et mois inversés donnent une date proche du mail (11/04 lu pour 04/11),
 * ou si elle a plus d'un an de plus que le mail.
 */
function dateDouteuse(date: string, recu: string): boolean {
  const ecart = jours(recu, date);
  if (ecart <= JOURS_PASSE) return false;
  if (ecart > 400) return true;
  const [y, m, j] = date.split("-");
  if (Number(j) > 12 || j === m) return false;
  const inverse = `${y}-${j}-${m}`;
  const e = jours(recu, inverse);
  return e >= -JOURS_FUTUR && e <= JOURS_PASSE;
}

const jours = (a: string, b: string) => (Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;

/** Liste des doutes sur une facture lue ; vide = elle peut être validée toute seule. */
export function doutesFacture(item: InboxFacture, ctx: ContexteValidation): Doute[] {
  const d: Doute[] = [];
  if (ctx.remiseAVerifier) d.push("remise_a_verifier");
  // PDF pas (encore) lu : une seule raison, inutile de lister tout ce qui manque.
  if (item.lecture || item.incomplet) {
    d.push(item.lecture ? "lecture" : "incomplete");
    return d;
  }
  if (!ctx.fournisseurConnu) d.push("fournisseur_inconnu");
  if (!item.numero?.trim()) d.push("sans_numero");

  const base = ctx.recuLe ?? ctx.aujourdhui;
  if (!item.dateFacture || !/^\d{4}-\d{2}-\d{2}$/.test(item.dateFacture)) d.push("sans_date");
  else if (jours(item.dateFacture, base) > JOURS_FUTUR || jours(item.dateFacture, ctx.aujourdhui) > JOURS_FUTUR) d.push("date_future");
  else if (dateDouteuse(item.dateFacture, base)) d.push("date_ancienne");

  const textes = [item.source.subject, item.source.attachment, item.numero].filter(Boolean).join(" ");
  const annonceAvoir = MOTS_AVOIR.test(textes);
  const negatif = item.montantTTC !== undefined && item.montantTTC < 0;
  // « Avoir » dans le mail mais montants positifs (ou l'inverse du sens) : pièce mal lue.
  if (MOTS_DOUTEUX.test(textes) || (annonceAvoir && !negatif)) d.push("type_document");
  if (item.etablissementPdf && item.etablissementPdf !== ctx.restaurant) d.push("autre_restaurant");

  const { montantHT: ht, montantTVA: tva, montantTTC: ttc } = item;
  if (ht === undefined || tva === undefined || ttc === undefined) d.push("montants_absents");
  else {
    // Avoir lu en négatif : validé seul s'il vient d'un fournisseur qui a déjà des factures et n'en dépasse pas la plus grosse.
    if (ttc < 0 && (ctx.fournisseurNouveau || !ctx.historiqueTTC.length || -ttc > Math.max(...ctx.historiqueTTC))) d.push("avoir");
    else if (ttc === 0) d.push("montant_nul");
    // Petit écart toléré : consigne, frais ou éco-participation hors TVA (2 € et 2 % du TTC au plus).
    const ecart = Math.abs(ht + tva - ttc);
    if (ecart > TOLERANCE_CALCUL && (ecart > ECART_MAX || ecart > Math.abs(ttc) * 0.02)) d.push("calcul");
    const [aHT, aTVA, signe] = [Math.abs(ht), Math.abs(tva), Math.sign(ttc)];
    if (ttc !== 0 && (Math.sign(tva) === -signe || Math.sign(ht) !== signe || aTVA > aHT * TAUX_MAX + TOLERANCE_CALCUL)) d.push("taux_tva");
    if (ttc > 0 && ctx.historiqueTTC.length >= HISTORIQUE_MIN && ttc > FACTEUR_INHABITUEL * Math.max(...ctx.historiqueTTC)) d.push("montant_inhabituel");
    if (ttc > PLAFOND_NOUVEAU && ctx.fournisseurNouveau && ctx.historiqueTTC.length === 0) d.push("montant_eleve");
  }
  if (ctx.doublon) d.push("doublon");
  return d;
}

/** Identifiant de la facture créée par la validation automatique : un même élément ne donne jamais deux factures. */
export const factureAutoId = (inboxId: string) => `mail-${inboxId}`.slice(0, 150);
