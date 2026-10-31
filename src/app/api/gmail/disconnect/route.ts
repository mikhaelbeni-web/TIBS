import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/admin";
import { requireGerant } from "@/lib/server/authz";
import { revoke } from "@/lib/server/google";

/** POST /api/gmail/disconnect (gérant) : révoque l'accès Google et efface le jeton. */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const db = adminDb();
  const priv = await db.doc("private/gmail").get();
  const token = priv.get("refreshToken") as string | undefined;
  if (token) await revoke(token);
  await db.doc("private/gmail").delete();
  await db.doc("settings/mail").set({ adresse: FieldValue.delete(), connecteLe: FieldValue.delete() }, { merge: true });
  return Response.json({ ok: true });
}
