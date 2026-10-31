import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { revoke } from "@/lib/server/google";

/** POST /api/gmail/disconnect?r=19e (gérant) : révoque l'accès Google et efface le jeton. */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const home = adminDb().doc(`restaurants/${rid}`);
  const priv = await home.collection("private").doc("gmail").get();
  const token = priv.get("refreshToken") as string | undefined;
  if (token) await revoke(token);
  await priv.ref.delete();
  await home.collection("settings").doc("mail").set({ adresse: FieldValue.delete(), connecteLe: FieldValue.delete() }, { merge: true });
  return Response.json({ ok: true });
}
