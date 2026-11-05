import { safeEqual } from "@/lib/ingest";
import { RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { synchroniserLAddition } from "@/lib/server/ticketZServeur";

export const maxDuration = 300;

/** Un passage par jour et par restaurant, après la fermeture (les Z de la veille sont alors disponibles). */
const INTERVALLE = 20 * 3600_000;
const HEURE_MIN = 6; // heure de Paris

/**
 * GET /api/cron/laddition (Authorization: Bearer CRON_SECRET), appelé toutes les heures par GitHub Actions.
 * Pour chaque restaurant dont les identifiants L'Addition sont renseignés : récupère les journées et les tickets Z.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const heure = Number(new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }));
  if (heure < HEURE_MIN) return Response.json({ attente: `avant ${HEURE_MIN} h` });
  const dus: RestaurantId[] = [];
  for (const r of RESTAURANTS) {
    const d = (await adminDb().doc(`restaurants/${r.id}/private/laddition`).get()).data();
    const etat = (await adminDb().doc(`restaurants/${r.id}/settings/ticketsZ`).get()).data();
    if (d?.identifiant && d?.motDePasse && Date.now() - (etat?.le ?? 0) >= INTERVALLE) dus.push(r.id);
  }
  const out: Record<string, unknown> = {};
  const debut = Date.now();
  for (const [i, id] of dus.entries()) {
    const reste = 270_000 - (Date.now() - debut);
    const b = await synchroniserLAddition(id, { budgetMs: Math.max(60_000, reste / (dus.length - i)) });
    out[id] = { jours: b.jours, zLus: b.zLus, echecs: b.echecs.length, ...(b.erreur ? { erreur: b.erreur } : {}) };
  }
  return Response.json({ dus, ...out });
}
