import "server-only";
import { isRestaurantId, type RestaurantId } from "@/lib/restaurants";
import { adminDb, serviceAccount } from "@/lib/server/admin";
import { verifyFirebaseIdToken } from "@/lib/server/idToken";

/** Vérifie le jeton Firebase envoyé par l'app (Authorization: Bearer <idToken>) et le rôle gérant. */
export async function requireGerant(request: Request): Promise<string | Response> {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return Response.json({ error: "non connecté" }, { status: 401 });
  let projectId: string;
  try {
    projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || serviceAccount().project_id || "";
  } catch (e) {
    return Response.json({ error: `Serveur : ${(e as Error).message}` }, { status: 500 });
  }
  let uid: string;
  try {
    uid = await verifyFirebaseIdToken(m[1], projectId);
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
