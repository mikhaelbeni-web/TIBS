import { majReleveJustifie } from "@/lib/server/releveJustifie";
import { requireGerant, restaurantParam } from "@/lib/server/authz";

export const maxDuration = 120;

/**
 * POST /api/releve?r=19e (gérant) : recalcule tout de suite la justification de chaque ligne du relevé bancaire
 * (bouton « Recalculer » de la page Relevé de compte). Lecture seule de la banque.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  try {
    const i = await majReleveJustifie(rid);
    return Response.json({ mois: i.mois.length, lignes: i.mois.reduce((s, m) => s + m.lignes, 0) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
