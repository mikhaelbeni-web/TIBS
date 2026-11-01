import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { relireIncomplets, syncMail } from "@/lib/server/mailSync";

export const maxDuration = 300;

/**
 * POST /api/gmail/sync?r=19e (gérant)
 * - sans mode : bouton « Relever les mails » (nouveaux mails, leurs PDF lus dans la limite des Réglages,
 *   puis relecture des éléments encore à compléter) ;
 * - mode=lire : bouton « Lire les PDF avec l'IA » (relit tous les éléments à compléter, même ceux en échec) ;
 * - mode=lire&i=<id> : relit le PDF d'un seul élément (bouton de la fiche).
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const params = new URL(request.url).searchParams;

  if (params.get("mode") === "lire") {
    const id = params.get("i");
    if (id !== null && !/^[A-Za-z0-9_-]{1,140}$/.test(id)) return Response.json({ error: "Élément inconnu." }, { status: 400 });
    const relu = await relireIncomplets(rid, { budgetMs: 270_000, force: true, ...(id ? { ids: [id] } : {}) });
    if (relu.status === "erreur") return Response.json({ error: relu.message ?? "Lecture impossible.", relu }, { status: 502 });
    return Response.json({ status: "ok", relu });
  }

  const started = Date.now();
  const r = await syncMail(rid, { budgetMs: 200_000 });
  if (r.status === "erreur") return Response.json(r, { status: 502 });
  const relu = r.status === "ok" ? await relireIncomplets(rid, { budgetMs: Math.max(0, 250_000 - (Date.now() - started)) }) : undefined;
  return Response.json({ ...r, relu });
}
