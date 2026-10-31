import "server-only";
import { getAuth } from "firebase-admin/auth";
import { adminApp, adminDb } from "@/lib/server/admin";

/** Vérifie le jeton Firebase envoyé par l'app (Authorization: Bearer <idToken>) et le rôle gérant. */
export async function requireGerant(request: Request): Promise<string | Response> {
  const m = (request.headers.get("authorization") ?? "").match(/^Bearer (.+)$/);
  if (!m) return Response.json({ error: "non connecté" }, { status: 401 });
  try {
    const { uid } = await getAuth(adminApp()).verifyIdToken(m[1]);
    const user = await adminDb().doc(`users/${uid}`).get();
    if (user.get("role") !== "gerant") return Response.json({ error: "réservé au gérant" }, { status: 403 });
    return uid;
  } catch {
    return Response.json({ error: "session expirée" }, { status: 401 });
  }
}
