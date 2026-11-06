import { majIncoherences } from "@/lib/server/incoherences";
import { requireGerant, restaurantParam } from "@/lib/server/authz";

export const maxDuration = 60;

/**
 * POST /api/incoherences?r=19e : recalcule tout de suite la liste « À regarder » de l'accueil (bouton « Recalculer »,
 * après un ticket Z déposé à la main ou un relevé importé). Le résultat est rangé dans settings/incoherences.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  try {
    const b = await majIncoherences(rid);
    return Response.json({ total: b.liste.length, attente: b.attente.length });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
