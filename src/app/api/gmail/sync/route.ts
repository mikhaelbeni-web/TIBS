import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { syncMail } from "@/lib/server/mailSync";

export const maxDuration = 300;

/** POST /api/gmail/sync?r=19e (gérant) : bouton « Vérifier maintenant ». */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const r = await syncMail(rid, { budgetMs: 240_000 });
  return Response.json(r, { status: r.status === "erreur" ? 502 : 200 });
}
