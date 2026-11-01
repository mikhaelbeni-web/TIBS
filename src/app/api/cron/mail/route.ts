import { safeEqual } from "@/lib/ingest";
import { parseReglages, releveDu } from "@/lib/reglages";
import { RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { relireIncomplets, syncMail, type SyncResult } from "@/lib/server/mailSync";

export const maxDuration = 300;

/**
 * GET /api/cron/mail (Authorization: Bearer CRON_SECRET) : réveil automatique.
 * Appelé toutes les heures par GitHub Actions (et une fois par jour par Vercel Cron, en secours).
 * Chaque restaurant n'est relevé que si sa fréquence (Réglages) est écoulée.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const db = adminDb();
  const dus: RestaurantId[] = [];
  for (const r of RESTAURANTS) {
    const status = (await db.doc(`restaurants/${r.id}/settings/mail`).get()).data() ?? {};
    if (releveDu(parseReglages(status.reglages), status.dernierPassage)) dus.push(r.id);
  }
  const out: Record<string, SyncResult | { status: "pas_encore" }> = {};
  for (const r of RESTAURANTS) if (!dus.includes(r.id)) out[r.id] = { status: "pas_encore" };
  for (const [i, id] of dus.entries()) {
    const left = 200_000 - (Date.now() - started);
    out[id] = await syncMail(id, { budgetMs: Math.max(10_000, left / (dus.length - i)) });
  }
  // Avec le temps restant : relecture des PDF encore « à compléter ».
  const relu: Record<string, unknown> = {};
  for (const id of dus) {
    const left = 270_000 - (Date.now() - started);
    if (left < 15_000) break;
    if (out[id]?.status === "ok") relu[id] = await relireIncomplets(id, { budgetMs: left / 2 });
  }
  const erreur = Object.values(out).some((x) => x.status === "erreur");
  return Response.json({ ...out, relu }, { status: erreur ? 502 : 200 });
}
