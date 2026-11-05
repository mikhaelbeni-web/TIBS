import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { banques, demarrer, signerState } from "@/lib/server/enableBanking";
import { appOrigin } from "@/lib/server/google";

const JOUR = 86_400_000;

/**
 * POST /api/banque/connect?r=19e (gérant) { banque, psuType } → { url } : page de la banque où le gérant
 * s'identifie et valide (code / SecurPass). L'accès obtenu est en lecture seule.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const body = (await request.json().catch(() => ({}))) as { banque?: string; psuType?: string };
  if (!body.banque) return Response.json({ error: "Choisis la banque." }, { status: 400 });
  const psuType = body.psuType === "personal" ? "personal" : "business";
  try {
    const b = (await banques()).find((x) => x.name === body.banque);
    if (!b) return Response.json({ error: "Banque introuvable dans la liste." }, { status: 400 });
    // Durée maximale autorisée par la banque (souvent 180 jours), moins une marge d'une heure.
    const max = (b.maximum_consent_validity ?? 90 * 86400) * 1000;
    const validUntil = new Date(Date.now() + Math.min(max, 180 * JOUR) - 3600_000).toISOString();
    const r = await demarrer({
      banque: b.name,
      psuType,
      redirect: `${appOrigin(request)}/api/banque/callback`,
      state: signerState(uid, rid),
      validUntil,
    });
    return Response.json({ url: r.url });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
