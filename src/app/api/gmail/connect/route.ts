import { restaurant } from "@/lib/restaurants";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { authUrl, signState } from "@/lib/server/google";

/** POST /api/gmail/connect?r=19e (gérant) → { url } : page de consentement Google vers laquelle rediriger. */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  try {
    return Response.json({ url: authUrl(request, signState(uid, rid), restaurant(rid).boiteMail) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
