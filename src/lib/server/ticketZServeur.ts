import "server-only";
import type { ServiceExport } from "@/lib/ladditionExport";
import { moisCle } from "@/lib/reglages";
import type { RestaurantId } from "@/lib/restaurants";
import { categorie, jourDuTicket, totaux, urlZAutorisee } from "@/lib/ticketZ";
import { adminDb } from "@/lib/server/admin";
import { extractionEnabled, extractTicketZ, type ExtractedTicketZ, type Lecteur } from "@/lib/server/extract";
import { extraireMois } from "@/lib/server/ladditionBot";
import { enregistrerConsommation, lecteurPour } from "@/lib/server/mailSync";
import { dechiffrer, type Chiffre } from "@/lib/server/secretBox";

/** Erreur à montrer telle quelle au gérant, avec le code HTTP à renvoyer. */
export class ZErreur extends Error {
  constructor(
    message: string,
    public status = 502,
  ) {
    super(message);
  }
}

/** Télécharge le PDF du Z tout de suite (le lien est signé et peut expirer ; il n'est ni stocké ni journalisé). */
export async function telechargerZ(lien: unknown): Promise<string> {
  const url = urlZAutorisee(lien);
  if (!url) throw new ZErreur("Lien de ticket Z non reconnu (data.laddition.com attendu).", 400);
  let res: Response;
  try {
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new ZErreur("Téléchargement du ticket Z impossible (lien expiré ou L'Addition injoignable).");
  }
  if (!res.ok) throw new ZErreur(`L'Addition a répondu ${res.status} pour le ticket Z (lien peut-être expiré).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4_000_000) throw new ZErreur("Ticket Z trop lourd.", 413);
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ZErreur("Le lien L'Addition n'a pas renvoyé de PDF.");
  return buf.toString("base64");
}

/** Ticket Z lu → document cashEntries de la journée de service. */
export function entreeDepuisZ(z: ExtractedTicketZ & { dateTicket: string }) {
  const jour = jourDuTicket(z.dateTicket, z.heureCloture);
  const paiements = z.paiements.map((p) => ({ ...p, categorie: categorie(p.libelle) }));
  const t = totaux(paiements);
  const entry = {
    date: jour,
    cb: t.cb,
    especes: t.especes,
    ticketsResto: t.ticketsResto,
    autres: t.autres,
    uber: t.uber,
    ...(paiements.some((p) => p.categorie === "uber" && p.nombre !== undefined) ? { uberCommandes: t.uberCommandes } : {}),
    ...(z.total !== undefined ? { total: z.total } : {}),
    ...(z.ttc55 !== undefined ? { ttc55: z.ttc55 } : {}),
    ...(z.ttc10 !== undefined ? { ttc10: z.ttc10 } : {}),
    ...(z.ttc20 !== undefined ? { ttc20: z.ttc20 } : {}),
    paiements,
    source: "ticketZ",
    ticketZ: { dateTicket: z.dateTicket, ...(z.heureCloture ? { heureCloture: z.heureCloture } : {}), luLe: Date.now() },
    createdAt: Date.now(),
  };
  return { jour, entry };
}

/** Lit un Z (PDF ou photo) avec l'IA et l'enregistre, en fusion, sur sa journée de service. */
export async function lireEtEnregistrerZ(rid: RestaurantId, fichier: { base64: string; mediaType: string }, lecteur: Lecteur) {
  if (!lecteur.peutLire()) {
    const raison = lecteur.raison === "budget" ? "budget IA du mois atteint (Réglages)" : lecteur.raison === "limite" ? "nombre max de lectures atteint" : "lecture IA désactivée dans les Réglages";
    throw new ZErreur(`Lecture impossible : ${raison}.`, 429);
  }
  let z: ExtractedTicketZ | null;
  try {
    z = await extractTicketZ(fichier, lecteur);
  } catch (e) {
    console.error("ticket-z", (e as Error).message);
    throw new ZErreur(`Lecture IA en échec : ${(e as Error).message}`);
  }
  if (!z) throw new ZErreur("Ce document ne ressemble pas à un ticket Z.", 422);
  if (!z.dateTicket) throw new ZErreur("Date du ticket illisible.", 422);
  const { jour, entry } = entreeDepuisZ({ ...z, dateTicket: z.dateTicket });
  // Fusion : garde les chiffres de l'export « Détails par service » (CA TTC net…) s'ils existent.
  await adminDb().doc(`restaurants/${rid}/cashEntries/${jour}`).set(entry, { merge: true });
  return { jour, entry };
}

/** Journées de l'export « Détails par service » (plusieurs services le même jour sont additionnés). */
export function journeesDesServices(services: ServiceExport[]) {
  const parJour = new Map<string, { cb: number; especes: number; uber: number; ttc10: number; ttc20: number; ttc55: number; caTtcNet: number; liens: string[] }>();
  for (const sv of services) {
    const d = parJour.get(sv.jour) ?? { cb: 0, especes: 0, uber: 0, ttc10: 0, ttc20: 0, ttc55: 0, caTtcNet: 0, liens: [] };
    d.cb += sv.cb;
    d.especes += sv.cash;
    d.uber += sv.uber;
    d.ttc10 += sv.ttc10;
    d.ttc20 += sv.ttc20;
    d.ttc55 += sv.ttc55;
    d.caTtcNet += sv.caTtcNet;
    if (sv.zUrl) d.liens.push(sv.zUrl);
    parJour.set(sv.jour, d);
  }
  return parJour;
}

export interface BilanServices {
  le: number;
  mois: string[];
  jours: number;
  zLus: number;
  /** Jours dont le Z n'a pas pu être lu (raison courte). */
  echecs: string[];
  erreur?: string;
}

/** Mois à relever : le mois en cours, et le précédent les 3 premiers jours (pour ses derniers services). */
export function moisARelever(now = new Date()): string[] {
  const m = moisCle(now);
  const jour = Number(now.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }).slice(8, 10));
  if (jour > 3) return [m];
  const [y, mm] = m.split("-").map(Number);
  const prec = mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, "0")}`;
  return [prec, m];
}

/**
 * Le robot se connecte à L'Addition avec les identifiants des Réglages, télécharge l'export
 * « Détails par service » du mois, enregistre chaque journée (CB, espèces, Uber, TTC) puis lit
 * les tickets Z qui ne l'ont pas encore été (nombre de commandes Uber, détail des paiements).
 */
export async function synchroniserLAddition(rid: RestaurantId, opts: { mois?: string[]; maxZ?: number; budgetMs?: number } = {}): Promise<BilanServices> {
  const debut = Date.now();
  const db = adminDb();
  const privRef = db.doc(`restaurants/${rid}/private/laddition`);
  const priv = (await privRef.get()).data();
  const bilan: BilanServices = { le: Date.now(), mois: opts.mois ?? moisARelever(), jours: 0, zLus: 0, echecs: [] };
  // État affiché dans Pointage (settings est lisible par le gérant ; private ne l'est pas).
  const fin = async () => {
    await db.doc(`restaurants/${rid}/settings/ticketsZ`).set(bilan);
    return bilan;
  };
  if (!priv?.identifiant || !priv?.motDePasse) {
    bilan.erreur = "Identifiants L'Addition non renseignés dans Réglages.";
    return fin();
  }
  let motDePasse: string;
  try {
    motDePasse = dechiffrer(priv.motDePasse as Chiffre);
  } catch {
    bilan.erreur = "Mot de passe L'Addition illisible : ressaisis-le dans Réglages.";
    return fin();
  }

  const statusRef = db.doc(`restaurants/${rid}/settings/mail`);
  const lecteur = lecteurPour((await statusRef.get()).data() ?? {});
  const budget = opts.budgetMs ?? 240_000;
  try {
    for (const mois of bilan.mois) {
      const r = await extraireMois({ identifiant: priv.identifiant, motDePasse, etablissement: priv.etablissement || undefined, mois, servicesSeulement: true });
      const jours = journeesDesServices(r.services ?? []);
      const existants = new Map(
        (await db.collection(`restaurants/${rid}/cashEntries`).where("date", ">=", `${mois}-01`).where("date", "<=", `${mois}-31`).get()).docs.map((d) => [d.id, d.data()]),
      );
      const batch = db.batch();
      for (const [jour, d] of jours) {
        const { liens: _liens, ...chiffres } = d;
        void _liens;
        batch.set(
          db.doc(`restaurants/${rid}/cashEntries/${jour}`),
          { date: jour, ...chiffres, ...(existants.has(jour) ? {} : { ticketsResto: 0, autres: 0, source: "laddition", createdAt: Date.now() }), servicesLAddition: Date.now() },
          { merge: true },
        );
      }
      await batch.commit();
      bilan.jours += jours.size;

      // Tickets Z pas encore lus (le lien expire : on télécharge et lit tout de suite, sans le garder).
      if (!extractionEnabled()) continue;
      for (const [jour, d] of [...jours].sort(([a], [b]) => b.localeCompare(a))) {
        if (existants.get(jour)?.ticketZ || !d.liens.length) continue;
        if ((opts.maxZ ?? 40) <= bilan.zLus || Date.now() - debut > budget) break;
        try {
          for (const lien of d.liens) {
            await lireEtEnregistrerZ(rid, { base64: await telechargerZ(lien), mediaType: "application/pdf" }, lecteur);
            bilan.zLus++;
          }
        } catch (e) {
          bilan.echecs.push(`${jour} : ${(e as Error).message}`);
          if (e instanceof ZErreur && e.status === 429) break;
        }
      }
    }
  } catch (e) {
    console.error("laddition services", (e as Error).message);
    bilan.erreur = (e as Error).message;
  } finally {
    await enregistrerConsommation(statusRef, lecteur).catch(() => {});
  }
  return fin();
}
