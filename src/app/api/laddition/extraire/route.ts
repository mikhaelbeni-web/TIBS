import { chiffresCoherents, estMois, type CaMensuel, type ChiffresCa } from "@/lib/laddition";
import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { extraireMois, LadditionError } from "@/lib/server/ladditionBot";
import { dechiffrer, type Chiffre } from "@/lib/server/secretBox";

export const maxDuration = 120;

/**
 * POST /api/laddition/extraire?r=19e&mois=2026-10 (gérant) : le robot lit L'Addition et
 * enregistre les chiffres du mois dans restaurants/{rid}/settings/caMensuel (champ {mois}) s'ils sont complets,
 * cohérents (10 % + 20 % + 5,5 % = CA TTC net) et pour le bon mois. Sinon : erreur + diagnostic.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const mois = new URL(request.url).searchParams.get("mois");
  if (!estMois(mois)) return Response.json({ error: "mois invalide (AAAA-MM)" }, { status: 400 });

  const privRef = adminDb().doc(`restaurants/${rid}/private/laddition`);
  const priv = (await privRef.get()).data();
  if (!priv?.identifiant || !priv?.motDePasse) {
    return Response.json({ error: "Identifiants L'Addition non renseignés : ajoute-les dans Réglages." }, { status: 400 });
  }
  let motDePasse: string;
  try {
    motDePasse = dechiffrer(priv.motDePasse as Chiffre);
  } catch {
    return Response.json({ error: "Mot de passe L'Addition illisible (clé du serveur changée) : ressaisis-le dans Réglages." }, { status: 400 });
  }

  try {
    const r = await extraireMois({ identifiant: priv.identifiant, motDePasse, etablissement: priv.etablissement || undefined, mois });
    const manquants = Object.entries(r.chiffres).filter(([, v]) => v === null).map(([k]) => k);
    if (!r.periodeConfirmee) {
      return Response.json({ error: `Je n'ai pas réussi à sélectionner ${mois} dans L'Addition.`, diagnostic: r.diagnostic }, { status: 422 });
    }
    if (manquants.length) {
      return Response.json({ error: `Chiffres introuvables sur la page : ${manquants.join(", ")}.`, diagnostic: r.diagnostic }, { status: 422 });
    }
    const chiffres = r.chiffres as ChiffresCa;
    const doc: CaMensuel = { mois, ...chiffres, source: "laddition", majLe: Date.now() };
    const coherent = chiffresCoherents(chiffres);
    await adminDb().doc(`restaurants/${rid}/settings/caMensuel`).set({ [mois]: { ...doc, coherent } }, { merge: true });
    await privRef.set({ dernierImport: { mois, le: doc.majLe } }, { merge: true });
    return Response.json({ ok: true, ...doc, coherent });
  } catch (e) {
    const d = e instanceof LadditionError ? e.diagnostic : undefined;
    console.error("laddition", (e as Error).message);
    return Response.json({ error: (e as Error).message, diagnostic: d }, { status: 502 });
  }
}
