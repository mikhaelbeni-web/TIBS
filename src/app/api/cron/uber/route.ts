import { safeEqual } from "@/lib/ingest";
import { RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
import { refUber, releverUber } from "@/lib/server/uberService";

export const maxDuration = 300;

/** Un passage du robot Uber Eats toutes les 12 heures au plus, par restaurant. */
const INTERVALLE = 12 * 3600_000;

/**
 * GET /api/cron/uber (Authorization: Bearer CRON_SECRET), appelé toutes les heures par GitHub Actions.
 * Pour chaque restaurant dont les identifiants Uber Eats sont renseignés : relève la liste des problèmes,
 * lit les montants, et conteste automatiquement si le mode automatique est activé dans Réglages.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const dus: RestaurantId[] = [];
  for (const r of RESTAURANTS) {
    const d = (await refUber(r.id).get()).data();
    if (d?.email && d?.motDePasse && Date.now() - (d.dernierPassage?.le ?? 0) >= INTERVALLE) dus.push(r.id);
  }
  const out: Record<string, unknown> = {};
  const debut = Date.now();
  for (const [i, id] of dus.entries()) {
    const reste = 270_000 - (Date.now() - debut);
    try {
      const r = await releverUber(id, { budgetMs: Math.max(60_000, reste / (dus.length - i)) });
      out[id] = { ok: true, lues: r.lues, ajoutees: r.ajoutees, contestees: r.contestees.length, echecs: r.echecs.length };
    } catch (e) {
      // L'erreur est enregistrée dans l'état du robot (visible dans l'app) ; le réveil ne doit pas échouer pour autant.
      out[id] = { ok: false, message: (e as Error).message };
    }
  }
  return Response.json({ dus, ...out });
}
