import { requireGerant } from "@/lib/server/authz";
import { syncMail } from "@/lib/server/mailSync";

export const maxDuration = 300;

/** POST /api/gmail/sync (gérant) : bouton « Vérifier maintenant ». */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const r = await syncMail({ budgetMs: 240_000 });
  return Response.json(r, { status: r.status === "erreur" ? 502 : 200 });
}
