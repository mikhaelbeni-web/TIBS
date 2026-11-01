import { FieldValue } from "firebase-admin/firestore";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { adminDb } from "@/lib/server/admin";

/**
 * POST /api/inbox/restaurer?r=19e&i=<id> (gérant) : remet dans « À vérifier » un élément ignoré par erreur.
 * Passe par le serveur pour ne pas élargir les règles Firestore (le navigateur ne peut que valider ou ignorer).
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const id = new URL(request.url).searchParams.get("i");
  if (!id || !/^[A-Za-z0-9_-]{1,140}$/.test(id)) return Response.json({ error: "Élément inconnu." }, { status: 400 });

  const ref = adminDb().doc(`restaurants/${rid}/inbox/${id}`);
  const snap = await ref.get();
  if (!snap.exists) return Response.json({ error: "Élément introuvable." }, { status: 404 });
  if (snap.get("statut") !== "rejete") return Response.json({ error: "Seul un élément ignoré peut être remis à vérifier." }, { status: 409 });
  await ref.update({ statut: "a_verifier", traiteLe: FieldValue.delete() });
  return Response.json({ status: "ok" });
}
