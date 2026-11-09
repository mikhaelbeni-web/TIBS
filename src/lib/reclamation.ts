import { formatEuros } from "./money";
import { cleEcart, normNumero, type Rapprochement, type Releve, type ReleveLigne } from "./releves";
import type { ModePaiement } from "./types";

/**
 * Réclamation des factures manquantes : une ligne du relevé fournisseur sans facture reçue
 * (ni validée, ni dans « À vérifier ») est réclamée au fournisseur par un mail envoyé depuis la boîte
 * du restaurant, uniquement sur un clic du gérant après aperçu.
 */
export interface Reclamation {
  le: number;
  a: string;
  numeros: string[];
  objet: string;
  messageId?: string;
  par?: string;
}

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");

/** Début de la comptabilité suivie dans l'app : une facture datée d'avant n'est pas réclamée. */
export const DEBUT_SUIVI = "2026-01-01";

/**
 * Lignes du relevé à réclamer : datées de 2026 ou après (DEBUT_SUIVI), non reçues, pas justifiées à la main, montant non nul, et pas reprises sur un
 * relevé plus récent du même fournisseur (`ailleurs` : numéros normalisés, comptés et réclamés là-bas).
 */
export function lignesAReclamer(r: Rapprochement, justifies: Record<string, string> = {}, ailleurs?: Set<string>): ReleveLigne[] {
  return r.lignes
    .filter((l) => l.etat === "non_recue" && l.ligne.montantTTC !== 0 && !(l.ligne.date && l.ligne.date < DEBUT_SUIVI) && !justifies[cleEcart("ligne", l.ligne.numero)] && !ailleurs?.has(normNumero(l.ligne.numero)))
    .map((l) => l.ligne);
}

/**
 * Un relevé de compte reprend les factures encore dues des mois précédents : la même facture figure sur
 * plusieurs relevés. Pour chaque relevé, les numéros qui figurent aussi sur un relevé plus récent du même
 * fournisseur (ils ne sont comptés et réclamés qu'une fois, sur le plus récent).
 */
export function reprisesPlusRecentes<R extends Pick<Releve, "fournisseur" | "supplierId" | "lignes" | "source" | "dateReleve" | "mois"> & { id: string }>(
  releves: R[],
): Map<string, Set<string>> {
  const date = (r: R) => r.source.receivedAt ?? r.dateReleve ?? `${r.mois}-28`;
  const cle = (r: R) => r.supplierId ?? nomCle(r.fournisseur);
  const out = new Map<string, Set<string>>();
  for (const r of releves) {
    const plusRecents = releves.filter((x) => x.id !== r.id && cle(x) === cle(r) && (date(x) > date(r) || (date(x) === date(r) && x.id > r.id)));
    out.set(r.id, new Set(plusRecents.flatMap((x) => x.lignes.map((l) => normNumero(l.numero)))));
  }
  return out;
}

/** Dernière réclamation qui couvrait cette ligne (même numéro), s'il y en a une. */
export function derniereReclamation(releve: Pick<Releve, "reclamations">, numero: string): Reclamation | undefined {
  const n = normNumero(numero);
  return [...(releve.reclamations ?? [])].reverse().find((x) => x.numeros.some((y) => normNumero(y) === n));
}

/** Adresse e-mail simple (une seule, sans nom affiché). */
export const emailValide = (s: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(s.trim());

export function periodeReleve(r: Pick<Releve, "periodeDebut" | "periodeFin" | "dateReleve" | "mois">): string {
  if (r.periodeDebut && r.periodeFin) return `du ${fr(r.periodeDebut)} au ${fr(r.periodeFin)}`;
  if (r.dateReleve) return `du ${fr(r.dateReleve)}`;
  const [y, m] = r.mois.split("-");
  return `de ${m}/${y}`;
}

/** Brouillon du mail (modifiable dans l'aperçu avant envoi). */
export function brouillonReclamation(
  releve: Pick<Releve, "numero" | "periodeDebut" | "periodeFin" | "dateReleve" | "mois" | "compteClient">,
  lignes: ReleveLigne[],
  signataire: { nom: string; adresse: string; societe?: string },
  mode: ModePaiement = "virement",
): { objet: string; corps: string } {
  const plusieurs = lignes.length > 1;
  const releveTxt = `votre relevé${releve.numero ? ` n° ${releve.numero}` : ""} ${periodeReleve(releve)}`;
  const liste = lignes
    .map((l) => `- Facture n° ${l.numero}${l.date ? ` du ${fr(l.date)}` : ""} : ${formatEuros(l.montantTTC)} TTC`)
    .join("\n");
  const pourquoi =
    mode === "prelevement"
      ? "afin que nous puissions les enregistrer dans notre comptabilité"
      : "afin que nous puissions effectuer le virement correspondant";
  const corps = [
    "Bonjour,",
    "",
    `${plusieurs ? "Les factures suivantes figurent" : "La facture suivante figure"} sur ${releveTxt}, mais nous ne ${plusieurs ? "les avons pas reçues" : "l'avons pas reçue"} :`,
    "",
    liste,
    "",
    `Pourriez-vous nous ${plusieurs ? "les envoyer" : "l'envoyer"} par retour de mail, ${pourquoi} ?`,
    "",
    "Merci d'avance et bonne journée,",
    "",
    signataire.nom,
    ...(signataire.societe ? [signataire.societe] : []),
    signataire.adresse,
    ...(releve.compteClient ? [`Compte client : ${releve.compteClient}`] : []),
  ].join("\n");
  const objet = plusieurs
    ? `Factures manquantes (${lignes.length}) – ${releveTxt.replace(/^votre /, "")}`
    : `Facture manquante n° ${lignes[0]?.numero ?? ""} – ${releveTxt.replace(/^votre /, "")}`;
  return { objet, corps };
}

export const nomCle = (n: string) =>
  n
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z0-9]/g, "");

const decaler = (iso: string, jours: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + jours * 86_400_000).toISOString().slice(0, 10);

/**
 * Factures du même fournisseur autour des dates du relevé (un mois avant la première ligne, un mois après
 * la dernière) : une facture peut être datée un peu autrement que sur le relevé.
 */
export function facturesPourReleve<F extends { supplierId: string; supplierNom: string; dateFacture: string }>(
  r: Pick<Releve, "supplierId" | "fournisseur" | "lignes" | "periodeDebut" | "periodeFin" | "mois">,
  factures: F[],
): F[] {
  const dates = r.lignes.map((l) => l.date).filter((d): d is string => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d))).sort();
  const debut = decaler(dates[0] ?? r.periodeDebut ?? `${r.mois}-01`, -31);
  const fin = decaler(dates.at(-1) ?? r.periodeFin ?? `${r.mois}-28`, 31);
  const cle = nomCle(r.fournisseur);
  return factures.filter(
    (f) => (r.supplierId ? f.supplierId === r.supplierId || nomCle(f.supplierNom) === cle : nomCle(f.supplierNom) === cle) && f.dateFacture >= debut && f.dateFacture <= fin,
  );
}

/** Mois d'un relevé : celui de la dernière ligne datée, sinon fin de période, jamais après la réception du mail. */
export function moisReleve(x: { lignes: { date?: string }[]; periodeFin?: string; dateReleve?: string }, recuLe?: string): string {
  const dates = x.lignes.map((l) => l.date ?? "").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const plafond = (recuLe ?? new Date().toISOString()).slice(0, 10);
  const candidat = dates.at(-1) ?? x.periodeFin ?? x.dateReleve ?? plafond;
  return (candidat > plafond ? (x.dateReleve && x.dateReleve <= plafond ? x.dateReleve : plafond) : candidat).slice(0, 7);
}
