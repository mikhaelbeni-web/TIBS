import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import type { BanquePrivee } from "@/lib/server/banqueSync";
import { fermerSession } from "@/lib/server/enableBanking";

/** POST /api/banque/disconnect?r=19e (gérant) : révoque l'accès bancaire. Les opérations déjà relevées sont gardées. */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const home = adminDb().doc(`restaurants/${rid}`);
  const priv = (await home.collection("private").doc("banque").get()).data() as BanquePrivee | undefined;
  if (priv?.sessionId) await fermerSession(priv.sessionId).catch(() => undefined);
  await home.collection("private").doc("banque").delete();
  await home.collection("settings").doc("banque").delete();
  return Response.json({ ok: true });
}
