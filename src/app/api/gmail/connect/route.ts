import { requireGerant } from "@/lib/server/authz";
import { authUrl, signState } from "@/lib/server/google";

/** POST /api/gmail/connect (gérant) → { url } : page de consentement Google vers laquelle rediriger. */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  try {
    return Response.json({ url: authUrl(request, signState(uid)) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
