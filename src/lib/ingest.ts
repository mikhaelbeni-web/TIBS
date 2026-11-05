import { toCents, toIsoDate } from "./money";
import { isRestaurantId, type RestaurantId } from "./restaurants";
import type { Doute } from "./autoValidation";

/**
 * Charge utile envoyée par la tâche quotidienne qui lit la boîte mail du restaurant.
 * Chaque élément arrive dans la collection `inbox` avec le statut « a_verifier ». Les factures dont la
 * lecture est cohérente et les récaps Uber complets sont ensuite validés tout seuls ; le reste attend le gérant.
 */
export type InboxKind = "facture" | "uber";

export interface InboxSource {
  messageId: string; // identifiant du mail, sert à éviter les doublons
  from?: string;
  subject?: string;
  receivedAt?: string; // ISO
  attachment?: string; // nom du PDF
  boite?: RestaurantId; // boîte Gmail d'où vient le mail (19e ou 17e)
}

/**
 * Les champs « ? » peuvent manquer quand le PDF n'a pas pu être lu (incomplet = true) :
 * le gérant les complète au moment de valider.
 */
/** Pourquoi le PDF n'a pas été lu par l'IA (affiché dans la fiche). */
export type Lecture = "limite" | "budget" | "desactivee" | "pas_facture" | "pas_de_pdf" | "erreur";

export interface InboxFacture {
  kind: "facture";
  fournisseur: string;
  numero?: string;
  dateFacture?: string; // AAAA-MM-JJ
  dateEcheance?: string;
  montantHT?: number; // centimes
  montantTVA?: number;
  montantTTC?: number;
  etablissement?: "19e" | "17e";
  /** Restaurant facturé d'après l'adresse client lue sur le PDF par l'IA. */
  etablissementPdf?: "19e" | "17e";
  incomplet?: boolean;
  lecture?: Lecture;
  lectureErreur?: string;
  source: InboxSource;
}

export interface InboxUber {
  kind: "uber";
  date?: string;
  montant?: number; // centimes nets
  brut?: number;
  frais?: number;
  reference?: string;
  /** Semaine couverte par le récap hebdo (lundi → dimanche), lue dans l'objet du mail. */
  debut?: string;
  fin?: string;
  /** Titres-restaurant versés à part (centimes). */
  titres?: number;
  /** Versement net du récap = versement bancaire + titres-restaurant (contrôle interne). */
  versementNet?: number;
  incomplet?: boolean;
  lecture?: Lecture;
  lectureErreur?: string;
  source: InboxSource;
}

export type InboxItem = InboxFacture | InboxUber;

export interface InboxDoc {
  item: InboxItem;
  statut: "a_verifier" | "valide" | "rejete" | "releve"; // releve : récapitulatif rangé dans les relevés fournisseurs
  receivedAt: number;
  traiteLe?: number;
  relu?: number; // dernière relecture du PDF par l'IA
  auto?: boolean; // enregistré sans validation manuelle (récap Uber complet et cohérent, ou facture lue sans doute)
  factureId?: string; // facture créée par la validation automatique
  /** Raisons pour lesquelles la facture n'a pas été validée toute seule (voir lib/autoValidation). */
  doutes?: Doute[];
  remiseAVerifier?: boolean; // le gérant a annulé une validation automatique : plus jamais validée seule
}

/**
 * Récap Uber hebdomadaire lu entièrement dans le corps du mail (sans IA) : s'il est complet et cohérent,
 * il est enregistré directement comme versement, pour que le pointage ticket Z ↔ Uber ↔ banque
 * se fasse sans clic. Renvoie null s'il manque quelque chose : l'élément reste alors « À vérifier ».
 */
export function versementDuMail(item: InboxUber): { id: string; payout: { date: string; montant: number; brut: number; frais?: number; titres?: number; debut: string; fin: string; reference: string; source: "mail" } } | null {
  const { date, montant, brut, debut, fin } = item;
  if (!date || montant === undefined || brut === undefined || !debut || !fin) return null;
  if (montant <= 0 || brut < montant) return null;
  // Contrôle interne du récap : versement bancaire + titres-restaurant = versement net (à 1 € près).
  if (item.versementNet !== undefined && Math.abs(montant + (item.titres ?? 0) - item.versementNet) > 100) return null;
  return {
    id: `mail-${debut}`,
    payout: {
      date,
      montant,
      brut,
      ...(item.frais !== undefined ? { frais: item.frais } : {}),
      ...(item.titres !== undefined ? { titres: item.titres } : {}),
      debut,
      fin,
      reference: item.reference ?? `Semaine du ${debut} au ${fin}`,
      source: "mail",
    },
  };
}

type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const cents = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : (toCents(v) ?? undefined));

function source(raw: unknown): InboxSource | string {
  if (!raw || typeof raw !== "object") return "source manquante";
  const s = raw as Raw;
  const messageId = str(s.messageId);
  if (!messageId) return "source.messageId manquant";
  return {
    messageId,
    ...(str(s.from) ? { from: str(s.from) } : {}),
    ...(str(s.subject) ? { subject: str(s.subject).slice(0, 300) } : {}),
    ...(str(s.receivedAt) ? { receivedAt: str(s.receivedAt) } : {}),
    ...(str(s.attachment) ? { attachment: str(s.attachment) } : {}),
    ...(isRestaurantId(s.boite) ? { boite: s.boite } : {}),
  };
}

/** Valide un élément. Les montants peuvent être envoyés en euros ("123,45" ou 123.45) : ils sont convertis en centimes. */
export function parseInboxItem(raw: unknown): InboxItem | string {
  if (!raw || typeof raw !== "object") return "élément invalide";
  const r = raw as Raw;
  const src = source(r.source);
  if (typeof src === "string") return src;

  if (r.kind === "facture") {
    const fournisseur = str(r.fournisseur);
    const dateFacture = toIsoDate(r.dateFacture);
    const montantTTC = cents(r.montantTTC);
    if (!fournisseur) return "fournisseur manquant";
    if (!dateFacture) return "dateFacture invalide";
    if (montantTTC === undefined) return "montantTTC invalide";
    const montantHT = cents(r.montantHT);
    const montantTVA = cents(r.montantTVA);
    const dateEcheance = toIsoDate(r.dateEcheance) ?? undefined;
    return {
      kind: "facture",
      fournisseur: fournisseur.slice(0, 120),
      ...(str(r.numero) ? { numero: str(r.numero).slice(0, 60) } : {}),
      dateFacture,
      ...(dateEcheance ? { dateEcheance } : {}),
      ...(montantHT !== undefined ? { montantHT } : {}),
      ...(montantTVA !== undefined ? { montantTVA } : {}),
      montantTTC,
      source: src,
    };
  }

  if (r.kind === "uber") {
    const date = toIsoDate(r.date);
    const montant = cents(r.montant);
    if (!date) return "date invalide";
    if (montant === undefined) return "montant invalide";
    const brut = cents(r.brut);
    const frais = cents(r.frais);
    return {
      kind: "uber",
      date,
      montant,
      ...(brut !== undefined ? { brut } : {}),
      ...(frais !== undefined ? { frais: Math.abs(frais) } : {}),
      ...(str(r.reference) ? { reference: str(r.reference).slice(0, 60) } : {}),
      source: src,
    };
  }
  return "kind doit valoir « facture » ou « uber »";
}

/** Identifiant du document inbox : un mail peut contenir plusieurs factures, d'où l'index. */
export function inboxDocId(messageId: string, index: number): string {
  return `${messageId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120)}_${index}`;
}

/** Comparaison de deux secrets en temps constant. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
