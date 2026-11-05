import "server-only";
import { idContestation, nouvelleFiche, type Contestation, type LigneUber } from "@/lib/contestations";
import type { RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";

export const colContestations = (rid: RestaurantId) => adminDb().collection(`restaurants/${rid}/uberContestations`);

export interface ResultatImport {
  ajoutees: number;
  misesAJour: number;
  inchangees: number;
  nouvellesIds: string[];
}

/**
 * Range des lignes lues dans Uber Eats Manager : crée les fiches manquantes,
 * met à jour l'état Uber des fiches connues (« Contestation refusée » → refusée), complète le montant s'il manquait.
 */
export async function importerLignes(rid: RestaurantId, lignes: (LigneUber & { montant?: number })[], origine: "collage" | "robot"): Promise<ResultatImport> {
  const col = colContestations(rid);
  const r: ResultatImport = { ajoutees: 0, misesAJour: 0, inchangees: 0, nouvellesIds: [] };
  if (!lignes.length) return r;
  const maintenant = Date.now();
  const refs = lignes.map((l) => col.doc(idContestation(l.commande, l.dateCommande)));
  const existants = await col.firestore.getAll(...refs);
  const batch = col.firestore.batch();
  lignes.forEach((l, i) => {
    const ex = existants[i];
    if (!ex.exists) {
      batch.set(refs[i], { ...nouvelleFiche(l, maintenant), ...(l.montant ? { montant: l.montant } : {}), origine });
      r.ajoutees++;
      r.nouvellesIds.push(refs[i].id);
      return;
    }
    const f = ex.data() as Contestation;
    const maj: Partial<Contestation> = {};
    if (l.etatUber !== f.etatUber && l.etatUber !== "autre") maj.etatUber = l.etatUber;
    if (l.etatUber === "contestation_refusee" && f.issue === "contestee") {
      maj.issue = "refusee";
      if (!f.dateReponse) maj.dateReponse = new Date(maintenant).toISOString().slice(0, 10);
    }
    if (l.justificatif && !f.justificatif) maj.justificatif = true;
    if (l.montant && f.montant === undefined) maj.montant = l.montant;
    if (Object.keys(maj).length) {
      batch.update(refs[i], { ...maj, updatedAt: maintenant });
      r.misesAJour++;
    } else r.inchangees++;
  });
  await batch.commit();
  return r;
}
