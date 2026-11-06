import { bilanCB, type BilanMoisCB } from "@/lib/controleCB";
import { safeEqual } from "@/lib/ingest";
import { estMois } from "@/lib/laddition";
import { moisCle } from "@/lib/reglages";
import { RESTAURANTS } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";

export const maxDuration = 60;

const decale = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * GET /api/cron/controle-cb?mois=AAAA-MM[,…][&r=19e] (Authorization: Bearer CRON_SECRET), lancé à la main par le
 * workflow « Rattrapage et contrôle CB ». Rapproche chaque journée du mois (CB du Z contre remises CB) et ne renvoie
 * que des compteurs : le journal du workflow est public, aucun montant ni libellé n'en sort.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const q = new URL(request.url).searchParams;
  const mois = [...new Set((q.get("mois") ?? "").split(",").filter((m) => estMois(m) && m <= moisCle(new Date())))].sort();
  if (!mois.length) return Response.json({ erreur: "mois=AAAA-MM attendu" }, { status: 400 });
  const seul = q.get("r");
  const debut = decale(`${mois[0]}-01`, -7);
  const fin = decale(`${mois[mois.length - 1]}-28`, 20);
  const out: Record<string, Record<string, BilanMoisCB>> = {};
  for (const r of RESTAURANTS) {
    if (seul && r.id !== seul) continue;
    const home = adminDb().doc(`restaurants/${r.id}`);
    const [cash, bank] = await Promise.all([
      home.collection("cashEntries").where("date", ">=", debut).where("date", "<=", fin).get(),
      home.collection("bankTransactions").where("date", ">=", debut).where("date", "<=", fin).get(),
    ]);
    const caisse = cash.docs.map((d) => ({ id: d.id, date: d.get("date") as string, amount: (d.get("cb") as number) ?? 0 }));
    const lignes = bank.docs.map((d) => {
      const valeur = d.get("valeur") as string | undefined;
      return { id: d.id, date: d.get("date") as string, amount: d.get("montant") as number, libelle: (d.get("libelle") as string) ?? "", ...(valeur ? { valeur } : {}) };
    });
    out[r.id] = Object.fromEntries(mois.map((m) => [m, bilanCB(m, caisse, lignes)]));
  }
  return Response.json(out);
}
