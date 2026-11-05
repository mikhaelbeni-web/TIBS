import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { synchroniserLAddition } from "@/lib/server/ticketZServeur";

export const maxDuration = 300;

/**
 * POST /api/laddition/services?r=19e (gérant) : « Récupérer depuis L'Addition » dans Pointage.
 * Même travail que le passage automatique : export « Détails par service » du mois, journées et tickets Z.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const bilan = await synchroniserLAddition(rid, { budgetMs: 250_000 });
  return Response.json(bilan, { status: bilan.erreur ? 502 : 200 });
}
