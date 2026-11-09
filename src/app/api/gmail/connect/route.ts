import { restaurant } from "@/lib/restaurants";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { authUrl, signState } from "@/lib/server/google";

/**
 * POST /api/gmail/connect?r=19e (gérant) → { url } : page de consentement Google vers laquelle rediriger.
 * &envoi=1 : demande aussi le droit d'envoyer des mails (réclamer les factures manquantes) ; &retour=/factures.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  try {
    const q = new URL(request.url).searchParams;
    const envoi = q.get("envoi") === "1";
    const retour = q.get("retour") ?? undefined;
    return Response.json({ url: authUrl(request, signState(uid, rid, Date.now(), envoi, retour), restaurant(rid).boiteMail, envoi) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
