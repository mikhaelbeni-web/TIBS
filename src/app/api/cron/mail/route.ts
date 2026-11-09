import { safeEqual } from "@/lib/ingest";
import { parseReglages, releveDu } from "@/lib/reglages";
import { RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { contreLire, relireIncomplets, syncMail, type SyncResult } from "@/lib/server/mailSync";
import { validerAutomatiquement, type AutoResult } from "@/lib/server/autoValider";
import { releveBanqueDu } from "@/lib/banque";
import { syncBanque, type BanqueSyncResult } from "@/lib/server/banqueSync";
import { majIncoherencesSiBesoin } from "@/lib/server/incoherences";
import { passeReleves } from "@/lib/server/relevesPasse";

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
  // Relevé bancaire (DSP2) : au plus toutes les 8 heures par restaurant, indépendamment des mails.
  const banque: Record<string, BanqueSyncResult | { status: "pas_encore" }> = {};
  for (const r of RESTAURANTS) {
    const etat = (await db.doc(`restaurants/${r.id}/settings/banque`).get()).data();
    if (!etat?.connecteLe) continue;
    banque[r.id] = releveBanqueDu(etat.dernierPassage) ? await syncBanque(r.id) : { status: "pas_encore" };
  }
  // Avec le temps restant : relecture des PDF encore « à compléter ».
  const relu: Record<string, unknown> = {};
  // (les deux restaurants à chaque réveil : les PDF non lus ne doivent pas attendre le prochain relevé des mails)
  for (const r of RESTAURANTS) {
    const left = 240_000 - (Date.now() - started);
    if (left < 15_000) break;
    if (out[r.id]?.status !== "erreur") relu[r.id] = await relireIncomplets(r.id, { budgetMs: left / 3 }).catch((e) => ({ erreur: (e as Error).message }));
  }
  // Validation automatique des factures cohérentes, à chaque réveil et pour les deux restaurants (arriéré compris).
  // Les factures dont HT + TVA ≠ TTC sont relues une fois par l'IA (écart signalé), puis réévaluées.
  const auto: Record<string, AutoResult | { erreur: string }> = {};
  const contre: Record<string, unknown> = {};
  for (const r of RESTAURANTS) {
    auto[r.id] = await validerAutomatiquement(r.id).catch((e) => ({ erreur: (e as Error).message }));
    const left = 270_000 - (Date.now() - started);
    if (left > 20_000 && "raisons" in auto[r.id] && (auto[r.id] as AutoResult).raisons?.calcul) {
      const c = await contreLire(r.id, { budgetMs: left / 2 }).catch((e) => ({ erreur: (e as Error).message, relus: 0, corriges: 0 }));
      contre[r.id] = c;
      if (c.corriges) auto[r.id] = await validerAutomatiquement(r.id).catch((e) => ({ erreur: (e as Error).message }));
    }
  }
  // Incohérences de l'accueil : recalculées après un relevé bancaire qui a apporté des opérations, sinon toutes les 12 h.
  const incoherences: Record<string, unknown> = {};
  for (const r of RESTAURANTS) {
    const b = banque[r.id];
    const n = await majIncoherencesSiBesoin(r.id, b?.status === "ok" && b.nouvelles > 0);
    if (n) incoherences[r.id] = n;
  }
  // Relevés fournisseurs (une fois par jour et par restaurant) : repérage + factures manquantes. Compteurs seulement.
  const releves: Record<string, unknown> = {};
  for (const r of RESTAURANTS) {
    const left = 285_000 - (Date.now() - started);
    if (left < 25_000) break;
    const p = await passeReleves(r.id, { budgetMs: left - 10_000 }).catch((e) => ({ erreur: (e as Error).message.slice(0, 200) }));
    if (p) releves[r.id] = p;
  }
  const erreur = Object.values(out).some((x) => x.status === "erreur");
  return Response.json({ ...out, relu, banque, auto, contre, incoherences, releves }, { status: erreur ? 502 : 200 });
}
