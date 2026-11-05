import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { syncBanque } from "@/lib/server/banqueSync";

export const maxDuration = 120;

/** POST /api/banque/sync?r=19e (gérant) : relevé bancaire immédiat. */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const r = await syncBanque(rid);
  if (r.status === "ok") return Response.json(r);
  const msg =
    r.status === "non_configuree" ? "La connexion bancaire n'est pas encore configurée sur le serveur." :
    r.status === "non_connectee" ? "Aucune banque connectée pour ce restaurant." : "erreur" in r ? r.erreur : "Erreur";
  return Response.json({ ...r, error: msg }, { status: r.status === "erreur" ? 502 : 409 });
}
