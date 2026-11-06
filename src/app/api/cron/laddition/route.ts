import { safeEqual } from "@/lib/ingest";
import { estMois } from "@/lib/laddition";
import { moisCle } from "@/lib/reglages";
import { RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { majIncoherencesSiBesoin } from "@/lib/server/incoherences";
import { synchroniserLAddition } from "@/lib/server/ticketZServeur";

export const maxDuration = 300;

/** Un passage par jour et par restaurant, après la fermeture (les Z de la veille sont alors disponibles). */
const INTERVALLE = 20 * 3600_000;
const HEURE_MIN = 6; // heure de Paris

/**
 * GET /api/cron/laddition (Authorization: Bearer CRON_SECRET), appelé toutes les heures par GitHub Actions.
 * Pour chaque restaurant dont les identifiants L'Addition sont renseignés : récupère les journées et les tickets Z.
 *
 * Rattrapage (workflow « Cohérence CB », à la main) : ?force=1&mois=AAAA-MM[&r=19e][&sansZ=1] relève ce mois
 * tout de suite, sans attendre l'intervalle et sans toucher à l'état du relevé quotidien.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const q = new URL(request.url).searchParams;
  const force = q.get("force") === "1";
  const mois = (q.get("mois") ?? "").split(",").filter((m) => estMois(m) && m <= moisCle(new Date()));
  if (force && !mois.length) return Response.json({ erreur: "mois=AAAA-MM attendu avec force=1" }, { status: 400 });
  const seul = q.get("r");
  const sansZ = q.get("sansZ") === "1";
  const heure = Number(new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", hour12: false }));
  if (!force && heure < HEURE_MIN) return Response.json({ attente: `avant ${HEURE_MIN} h` });
  const dus: RestaurantId[] = [];
  for (const r of RESTAURANTS) {
    if (seul && r.id !== seul) continue;
    const d = (await adminDb().doc(`restaurants/${r.id}/private/laddition`).get()).data();
    const etat = (await adminDb().doc(`restaurants/${r.id}/settings/ticketsZ`).get()).data();
    if (d?.identifiant && d?.motDePasse && (force || Date.now() - (etat?.le ?? 0) >= INTERVALLE)) dus.push(r.id);
  }
  const out: Record<string, unknown> = {};
  const debut = Date.now();
  for (const [i, id] of dus.entries()) {
    const reste = 270_000 - (Date.now() - debut);
    const b = await synchroniserLAddition(id, {
      budgetMs: Math.max(60_000, reste / (dus.length - i)),
      ...(force ? { mois, noter: false } : {}),
      ...(sansZ ? { maxZ: 0 } : {}),
    });
    // Nouvelles journées de caisse : les incohérences de l'accueil sont recalculées (relevé quotidien seulement).
    const inc = !force && b.jours > 0 ? await majIncoherencesSiBesoin(id, true) : null;
    out[id] = { jours: b.jours, zLus: b.zLus, echecs: b.echecs.length, ...(b.erreur ? { erreur: b.erreur } : {}), ...(inc ? { incoherences: inc } : {}) };
  }
  return Response.json({ dus, ...out });
}
