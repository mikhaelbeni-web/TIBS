import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { relireIncomplets, syncMail } from "@/lib/server/mailSync";

export const maxDuration = 300;

/**
 * POST /api/gmail/sync?r=19e (gérant) : bouton « Vérifier maintenant ».
 * Relève les nouveaux mails, puis relit les PDF des éléments encore « à compléter ».
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const started = Date.now();
  const r = await syncMail(rid, { budgetMs: 200_000 });
  if (r.status === "erreur") return Response.json(r, { status: 502 });
  const relu = r.status === "ok" ? await relireIncomplets(rid, { budgetMs: Math.max(0, 250_000 - (Date.now() - started)) }) : undefined;
  return Response.json({ ...r, relu });
}
