import { bilanCB, type BilanMoisCB } from "@/lib/controleCB";
import { comparerCB, lotDuMatinPossible } from "@/lib/ticketZ";
import { safeEqual } from "@/lib/ingest";
import { estMois } from "@/lib/laddition";
import { moisCle } from "@/lib/reglages";
import { RESTAURANTS } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { syncBanque } from "@/lib/server/banqueSync";

export const maxDuration = 300;

const decale = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * GET /api/cron/controle-cb?mois=AAAA-MM[,…][&r=19e] (Authorization: Bearer CRON_SECRET), lancé à la main par le
 * workflow « Rattrapage et contrôle CB ». Rapproche chaque journée du mois (CB du Z contre remises CB) et ne renvoie
 * que des compteurs : le journal du workflow est public, aucun montant ni libellé n'en sort.
 * &detail=1 : détail de chaque crédit dans le journal Vercel (privé), jamais dans la réponse.
 * &releve=1 : relève d'abord la banque (lecture seule) sans attendre l'intervalle de 8 h, pour les restaurants reliés.
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
  const releve: Record<string, unknown> = {};
  for (const r of RESTAURANTS) {
    if (seul && r.id !== seul) continue;
    const home = adminDb().doc(`restaurants/${r.id}`);
    if (q.get("releve") === "1" && (await home.collection("settings").doc("banque").get()).get("connecteLe")) {
      const b = await syncBanque(r.id);
      releve[r.id] = b.status === "ok" ? { status: b.status, nouvelles: b.nouvelles, valeurs: b.valeurs } : { status: b.status };
    }
    const [cash, bank] = await Promise.all([
      home.collection("cashEntries").where("date", ">=", debut).where("date", "<=", fin).get(),
      home.collection("bankTransactions").where("date", ">=", debut).where("date", "<=", fin).get(),
    ]);
    const caisse = cash.docs.map((d) => ({ id: d.id, date: d.get("date") as string, amount: (d.get("cb") as number) ?? 0 }));
    const lignes = bank.docs.map((d) => {
      const valeur = d.get("valeur") as string | undefined;
      return { id: d.id, date: d.get("date") as string, amount: d.get("montant") as number, libelle: (d.get("libelle") as string) ?? "", ...(valeur ? { valeur } : {}) };
    });
    try {
      out[r.id] = Object.fromEntries(mois.map((m) => [m, bilanCB(m, caisse, lignes)]));
    } catch (e) {
      // Message d'erreur seulement (jamais de données) : la réponse est affichée dans un journal public.
      const err = e instanceof Error ? `${e.name}: ${e.message} @ ${(e.stack ?? "").split("\n").slice(1, 3).join(" | ")}` : String(e);
      return Response.json({ erreur: err.slice(0, 400) }, { status: 500 });
    }
    // &detail=1 : chaque crédit du mois (règle déduite) dans le journal Vercel, privé ; la réponse, publique, reste en compteurs.
    if (q.get("detail") === "1") {
      const sans = lignes.map((b) => ({ id: b.id, date: b.date, amount: b.amount, libelle: b.libelle }));
      const positifs = sans.filter((b) => b.amount > 0);
      const vus = new Set<string>();
      const premiere = sans.reduce((m, b) => (b.date < m ? b.date : m), "9999");
      console.log("controle-cb detail", r.id, JSON.stringify({ premiereLigne: premiere, lignes: sans.length }));
      for (const c of caisse.filter((x) => x.amount > 0 && mois.some((m) => x.date.startsWith(m))).sort((a, b) => a.date.localeCompare(b.date))) {
        const x = comparerCB(c.date, caisse, positifs, { lignes: sans });
        if (!x.banque || vus.has(x.banque.date)) {
          if (!x.banque) console.log("controle-cb detail", r.id, JSON.stringify({ jour: c.date, caisse: c.amount, statut: x.statut }));
          continue;
        }
        vus.add(x.banque.date);
        console.log(
          "controle-cb detail",
          r.id,
          JSON.stringify({
            credit: x.banque.date,
            jours: x.joursCouverts?.map((j) => [j.date, j.amount]),
            caisse: x.caisse,
            banque: x.banque.montant,
            ecart: x.ecart,
            lots: x.remises?.map((b) => [b.date, b.amount, lotDuMatinPossible({ ...b, valeur: undefined }) ? "0" : "1", b.valeurDeduite ? "matin" : ""]),
          }),
        );
      }
    }
  }
  return Response.json({ ...(Object.keys(releve).length ? { releve } : {}), ...out });
}
