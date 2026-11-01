import "server-only";
import { isRestaurantId, type RestaurantId } from "@/lib/restaurants";
import { adminApp, adminDb } from "@/lib/server/admin";

/** Vérifie le jeton Firebase envoyé par l'app (Authorization: Bearer <idToken>) et le rôle gérant. */
export async function requireGerant(request: Request): Promise<string | Response> {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return Response.json({ error: "non connecté" }, { status: 401 });
  let auth;
  try {
    // Import dynamique : une panne de chargement du module devient un message lisible au lieu d'un plantage.
    const { getAuth } = await import("firebase-admin/auth");
    auth = getAuth(adminApp());
  } catch (e) {
    return Response.json({ error: `Serveur : ${(e as Error).message}` }, { status: 500 });
  }
  let uid: string;
  try {
    ({ uid } = await auth.verifyIdToken(m[1]));
  } catch (e) {
    console.error("verifyIdToken", e);
    return Response.json({ error: "session expirée, reconnecte-toi" }, { status: 401 });
  }
  try {
    const user = await adminDb().doc(`users/${uid}`).get();
    if (user.get("role") !== "gerant") return Response.json({ error: "réservé au gérant" }, { status: 403 });
    return uid;
  } catch (e) {
    return Response.json({ error: `Base de données : ${(e as Error).message}` }, { status: 500 });
  }
}

/** Restaurant visé par la requête (?r=19e ou ?r=17e). */
export function restaurantParam(request: Request): RestaurantId | Response {
  const r = new URL(request.url).searchParams.get("r");
  return isRestaurantId(r) ? r : Response.json({ error: "restaurant inconnu" }, { status: 400 });
}
