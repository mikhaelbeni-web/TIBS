import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { UberError } from "@/lib/server/uberEatsBot";
import { releverUber } from "@/lib/server/uberService";

export const maxDuration = 180;

/** POST /api/uber-eats/relever?r=19e (gérant) : le robot lit la liste des problèmes et met à jour le suivi. */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  try {
    const r = await releverUber(rid, { budgetMs: 150_000 });
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const u = e as UberError;
    console.error("uber relever", u.message);
    return Response.json({ error: u.message, besoin: u.besoin, diagnostic: u.diagnostic }, { status: 502 });
  }
}
