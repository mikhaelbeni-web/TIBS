import { safeEqual } from "@/lib/ingest";
import { syncAll } from "@/lib/server/mailSync";

export const maxDuration = 300;

/** GET /api/cron/mail : appelé chaque jour par Vercel Cron, relève la boîte de chaque restaurant (Authorization: Bearer CRON_SECRET). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const r = await syncAll(270_000);
  return Response.json(r, { status: Object.values(r).some((x) => x.status === "erreur") ? 502 : 200 });
}
