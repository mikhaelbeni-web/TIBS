import { safeEqual } from "@/lib/ingest";
import { RESTAURANTS } from "@/lib/restaurants";
import { relireIncomplets, syncAll } from "@/lib/server/mailSync";

export const maxDuration = 300;

/** GET /api/cron/mail : appelé chaque jour par Vercel Cron, relève la boîte de chaque restaurant (Authorization: Bearer CRON_SECRET). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const started = Date.now();
  const r = await syncAll(200_000);
  // Avec le temps restant : relecture des PDF encore « à compléter ».
  const relu: Record<string, unknown> = {};
  for (const { id } of RESTAURANTS) {
    const left = 270_000 - (Date.now() - started);
    if (left < 15_000) break;
    if (r[id]?.status === "ok") relu[id] = await relireIncomplets(id, { budgetMs: left / 2 });
  }
  return Response.json({ ...r, relu }, { status: Object.values(r).some((x) => x.status === "erreur") ? 502 : 200 });
}
