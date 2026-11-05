import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { UberError } from "@/lib/server/uberEatsBot";
import { contesterFiche } from "@/lib/server/uberService";

export const maxDuration = 300;

/**
 * POST /api/uber-eats/contester?r=19e { id, essai? } (gérant) : le robot conteste une commande dans Uber Eats Manager.
 * essai = true : il remplit le formulaire sans l'envoyer et renvoie une capture pour vérifier.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const b = (await request.json().catch(() => null)) as { id?: unknown; essai?: unknown } | null;
  if (typeof b?.id !== "string" || !b.id) return Response.json({ error: "id manquant" }, { status: 400 });
  try {
    const r = await contesterFiche(rid, b.id, b.essai === true);
    return Response.json({ ok: true, ...r });
  } catch (e) {
    const u = e as UberError;
    console.error("uber contester", u.message);
    return Response.json({ error: u.message, besoin: u.besoin, diagnostic: u.diagnostic }, { status: 502 });
  }
}
