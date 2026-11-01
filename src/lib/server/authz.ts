import "server-only";
import { getAuth } from "firebase-admin/auth";
import { isRestaurantId, type RestaurantId } from "@/lib/restaurants";
import { adminApp, adminDb } from "@/lib/server/admin";

/** Vérifie le jeton Firebase envoyé par l'app (Authorization: Bearer <idToken>) et le rôle gérant. */
export async function requireGerant(request: Request): Promise<string | Response> {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return Response.json({ error: "non connecté" }, { status: 401 });
  let app;
  try {
    app = adminApp();
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
  try {
    const { uid } = await getAuth(app).verifyIdToken(m[1]);
    const user = await adminDb().doc(`users/${uid}`).get();
    if (user.get("role") !== "gerant") return Response.json({ error: "réservé au gérant" }, { status: 403 });
    return uid;
  } catch {
    return Response.json({ error: "session expirée" }, { status: 401 });
  }
}

/** Restaurant visé par la requête (?r=19e ou ?r=17e). */
export function restaurantParam(request: Request): RestaurantId | Response {
  const r = new URL(request.url).searchParams.get("r");
  return isRestaurantId(r) ? r : Response.json({ error: "restaurant inconnu" }, { status: 400 });
}
