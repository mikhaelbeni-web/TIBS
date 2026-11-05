import { toCents, toIsoDate } from "./money";

/**
 * Contestations des erreurs de commande Uber Eats (Uber Eats Manager > Commandes > Problème).
 * Une fiche par commande, sous restaurants/{rid}/uberContestations/{id}, pour suivre :
 * réclamation du client → retenue Uber → contestation du restaurant → réponse d'Uber → versement récupéré.
 * Montants en centimes, dates en AAAA-MM-JJ.
 */

/** Étiquette rouge sous le motif dans Uber Eats Manager (colonne « Problème »). */
export type EtatUber = "probleme_facture" | "rembourse_uber" | "contestation_refusee" | "autre";

export type Issue = "a_contester" | "contestee" | "acceptee" | "refusee" | "abandonnee";

export interface Contestation {
  commande: string; // identifiant court Uber, ex. 57FF6
  dateCommande: string;
  heure?: string;
  client?: string;
  motif: string; // « Mauvaise commande reçue », « 1 article endommagé »…
  etatUber: EtatUber;
  justificatif?: boolean; // le client a joint une photo
  montant?: number; // retenu par Uber sur le versement (centimes)
  dateReclamation?: string; // jour où le client a réclamé (souvent le jour de la commande)
  dateContestation?: string;
  commentaire?: string; // texte envoyé à Uber
  issue: Issue;
  dateReponse?: string;
  montantRecupere?: number;
  dateVersement?: string; // versement Uber qui contient le remboursement
  note?: string;
  origine?: "collage" | "robot";
  contesteePar?: "robot" | "main";
  /** Dernière tentative du robot qui a échoué (affichée sur la fiche). */
  erreurRobot?: { message: string; le: number };
  createdAt: number;
  updatedAt?: number;
}

export const ISSUES: Record<Issue, { label: string; tone: "neutral" | "green" | "orange" | "red" | "info" }> = {
  a_contester: { label: "À contester", tone: "orange" },
  contestee: { label: "Contestée, en attente", tone: "info" },
  acceptee: { label: "Acceptée", tone: "green" },
  refusee: { label: "Refusée", tone: "red" },
  abandonnee: { label: "Non contestée", tone: "neutral" },
};

export const ETATS_UBER: Record<EtatUber, string> = {
  probleme_facture: "Problème facturé",
  rembourse_uber: "Remboursement effectué par Uber",
  contestation_refusee: "Contestation refusée",
  autre: "Autre",
};

const sansAccents = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

export function etatDepuisTexte(s: string): EtatUber {
  const t = sansAccents(s);
  if (t.includes("probleme facture")) return "probleme_facture";
  if (t.includes("rembourse") && t.includes("uber")) return "rembourse_uber";
  if (t.includes("contestation refusee")) return "contestation_refusee";
  return "autre";
}

/** Règle du gérant : on ne conteste que « Problème facturé » et « Remboursement effectué par Uber ». */
export function aContester(etat: EtatUber): boolean {
  return etat === "probleme_facture" || etat === "rembourse_uber";
}

/** Identifiant du document : la commande et sa date (les identifiants courts Uber peuvent revenir). */
export function idContestation(commande: string, dateCommande: string): string {
  return `${dateCommande}_${commande.toUpperCase()}`;
}

const MESSAGE_VERIFICATION =
  "Bonjour, chaque commande est vérifiée par deux équipiers avant d'être remise au coursier : le contenu était complet et conforme au moment de la remise. L'erreur ne peut pas être imputée au restaurant ; merci d'annuler la retenue sur notre versement.";
const MESSAGE_LIVRAISON =
  "Bonjour, la commande a été préparée, vérifiée par deux équipiers et remise au coursier dans les temps. Le retard ou la non-réception relève de la livraison, pas du restaurant ; merci d'annuler la retenue sur notre versement.";

/** Message proposé selon le motif : la double vérification ne répond pas à un retard ou une non-réception. */
export function messageParDefaut(motif: string): string {
  const t = sansAccents(motif);
  if (t.includes("retard") || t.includes("non recue") || t.includes("jamais recu")) return MESSAGE_LIVRAISON;
  return MESSAGE_VERIFICATION;
}

export interface LigneUber {
  commande: string;
  dateCommande: string;
  heure?: string;
  client?: string;
  motif: string;
  etatUber: EtatUber;
  justificatif: boolean;
}

const RE_COMMANDE = /^[0-9A-F]{5}$/;
const MOTIFS_CONNUS = [
  "mauvaise commande recue",
  "commande recue en retard",
  "commande non recue",
  "article manquant",
  "articles manquants",
  "article endommage",
  "articles endommages",
  "commande endommagee",
  "commande renversee",
  "probleme de qualite",
  "temperature",
];

/**
 * Lit les lignes copiées depuis le tableau « Problème » d'Uber Eats Manager (sélection + copier-coller).
 * Le copier-coller met souvent une cellule par ligne : on découpe sur les identifiants de commande.
 */
export function lireCopieUber(texte: string): LigneUber[] {
  const jetons = texte
    .split(/[\t\r\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const blocs: string[][] = [];
  for (const j of jetons) {
    if (RE_COMMANDE.test(j)) blocs.push([j]);
    else if (blocs.length) blocs[blocs.length - 1].push(j);
  }
  const lignes: LigneUber[] = [];
  for (const [commande, ...cellules] of blocs) {
    const iDate = cellules.findIndex((c) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(c));
    const dateCommande = iDate >= 0 ? toIsoDate(cellules[iDate]) : null;
    if (!dateCommande) continue;
    const heure = cellules.find((c) => /^\d{1,2}:\d{2}$/.test(c));
    const iHeure = heure ? cellules.indexOf(heure) : -1;
    const client = iHeure >= 0 ? cellules[iHeure + 1] : undefined;
    const reste = cellules.join(" | ");
    const etatUber = etatDepuisTexte(reste);
    const motif =
      cellules.find((c) => {
        const t = sansAccents(c);
        return MOTIFS_CONNUS.some((m) => t.includes(m)) || /^\d+ articles? /.test(t);
      }) ?? "";
    lignes.push({
      commande,
      dateCommande,
      ...(heure ? { heure } : {}),
      ...(client && !/livraison|eats|retrait/i.test(client) ? { client } : {}),
      motif: motif.replace(/^[⚠\s]+/, ""),
      etatUber,
      justificatif: sansAccents(reste).includes("justificatif"),
    });
  }
  return lignes;
}

/** Fiche neuve depuis une ligne Uber : « à contester » si la règle s'applique, sinon « non contestée ». */
export function nouvelleFiche(l: LigneUber, maintenant = Date.now()): Contestation {
  return {
    commande: l.commande.toUpperCase(),
    dateCommande: l.dateCommande,
    ...(l.heure ? { heure: l.heure } : {}),
    ...(l.client ? { client: l.client } : {}),
    motif: l.motif,
    etatUber: l.etatUber,
    justificatif: l.justificatif,
    dateReclamation: l.dateCommande,
    commentaire: messageParDefaut(l.motif),
    issue: aContester(l.etatUber) ? "a_contester" : "abandonnee",
    createdAt: maintenant,
  };
}

/** Montant saisi (« 12,50 ») → centimes positifs, ou undefined. */
export function montantSaisi(s: string): number | undefined {
  const c = toCents(s);
  return c === null ? undefined : Math.abs(c);
}

export interface Bilan {
  nombre: number;
  retenu: number; // somme des montants retenus connus
  recupere: number;
  enAttente: number; // retenu sur les fiches à contester ou contestées
  perdu: number; // retenu sur les fiches refusées ou non contestées
  sansMontant: number;
}

export function bilan(fiches: Pick<Contestation, "issue" | "montant" | "montantRecupere">[]): Bilan {
  const b: Bilan = { nombre: fiches.length, retenu: 0, recupere: 0, enAttente: 0, perdu: 0, sansMontant: 0 };
  for (const f of fiches) {
    const m = f.montant ?? 0;
    if (f.montant === undefined) b.sansMontant++;
    b.retenu += m;
    if (f.issue === "acceptee") {
      const r = f.montantRecupere ?? m;
      b.recupere += r;
      b.perdu += Math.max(0, m - r);
    } else if (f.issue === "a_contester" || f.issue === "contestee") b.enAttente += m;
    else b.perdu += m;
  }
  return b;
}

/** Regroupe par mois de commande (AAAA-MM), du plus récent au plus ancien. */
export function parMois<T extends Pick<Contestation, "dateCommande">>(fiches: T[]): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const f of fiches) {
    const k = f.dateCommande.slice(0, 7);
    m.set(k, [...(m.get(k) ?? []), f]);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

/** Champs modifiables par le gérant (le reste vient d'Uber). */
export const CHAMPS_MODIFIABLES = [
  "motif",
  "etatUber",
  "montant",
  "dateReclamation",
  "dateContestation",
  "commentaire",
  "issue",
  "dateReponse",
  "montantRecupere",
  "dateVersement",
  "note",
  "client",
  "heure",
] as const;
