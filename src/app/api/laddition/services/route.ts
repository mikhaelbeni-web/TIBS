import { estMois } from "@/lib/laddition";
import { moisCle } from "@/lib/reglages";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { synchroniserLAddition } from "@/lib/server/ticketZServeur";

export const maxDuration = 300;

/**
 * POST /api/laddition/services?r=19e (gérant) { mois?: "AAAA-MM" } : « Récupérer » dans Caisse > Jour à jour.
 * Même travail que le passage automatique : export « Détails par service » du mois (celui de la journée
 * choisie, sinon le mois en cours), journées et tickets Z.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const body = (await request.json().catch(() => null)) as { mois?: unknown } | null;
  const mois = estMois(body?.mois) && body.mois <= moisCle(new Date()) ? [body.mois] : undefined;
  const bilan = await synchroniserLAddition(rid, { budgetMs: 250_000, ...(mois ? { mois } : {}) });
  return Response.json(bilan, { status: bilan.erreur ? 502 : 200 });
}
