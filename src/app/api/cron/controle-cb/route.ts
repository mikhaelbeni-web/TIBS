import { bilanCB, type BilanMoisCB } from "@/lib/controleCB";
import { categorie, comparerCB, controleTotal, lotDuMatinPossible, totaux, type LignePaiement } from "@/lib/ticketZ";
import { safeEqual } from "@/lib/ingest";
import { estMois } from "@/lib/laddition";
import { moisCle } from "@/lib/reglages";
import { RESTAURANTS } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { syncBanque } from "@/lib/server/banqueSync";
import { majIncoherences } from "@/lib/server/incoherences";

export const maxDuration = 300;

const decale = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * GET /api/cron/controle-cb?mois=AAAA-MM[,…][&r=19e] (Authorization: Bearer CRON_SECRET), lancé à la main par le
 * workflow « Rattrapage et contrôle CB ». Rapproche chaque journée du mois (CB du Z contre remises CB) et ne renvoie
 * que des compteurs : le journal du workflow est public, aucun montant ni libellé n'en sort.
 * &detail=1 : détail de chaque crédit dans le journal Vercel (privé), jamais dans la réponse.
 * &totalz=1 : contrôle « total imprimé = somme des paiements » de chaque Z, ancienne règle contre nouvelle (trop perçu
 *   hors total) ; compteurs dans la réponse, libellés « autres » et dates dans le journal Vercel (privé).
 *   &corriger=1 : réécrit catégories et « autres » des Z déjà enregistrés d'après la règle actuelle.
 * &releve=1 : relève d'abord la banque (lecture seule) sans attendre l'intervalle de 8 h, pour les restaurants reliés.
 */
export async function GET(request: Request) {
  try {
    return await controler(request);
  } catch (e) {
    // Message d'erreur seulement (jamais de données) : la réponse est affichée dans un journal public.
    const err = e instanceof Error ? `${e.name}: ${e.message} @ ${(e.stack ?? "").split("\n").slice(1, 3).join(" | ")}` : String(e);
    return Response.json({ erreur: err.slice(0, 400) }, { status: 500 });
  }
}

async function controler(request: Request) {
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
  const out: Record<string, Record<string, BilanMoisCB & { modesCaisse: { joursTR: number; joursAutres: number } }>> = {};
  const releve: Record<string, unknown> = {};
  for (const r of RESTAURANTS) {
    if (seul && r.id !== seul) continue;
    const home = adminDb().doc(`restaurants/${r.id}`);
    if (q.get("releve") === "1" && (await home.collection("settings").doc("banque").get()).get("connecteLe")) {
      const b = await syncBanque(r.id);
      releve[r.id] = b.status === "ok" ? { status: b.status, nouvelles: b.nouvelles, valeurs: b.valeurs } : { status: b.status };
    }
    const [cash, bank, uber] = await Promise.all([
      home.collection("cashEntries").where("date", ">=", debut).where("date", "<=", fin).get(),
      home.collection("bankTransactions").where("date", ">=", debut).where("date", "<=", fin).get(),
      home.collection("uberPayouts").where("date", ">=", debut).where("date", "<=", fin).get(),
    ]);
    const titresUber = uber.docs
      .filter((d) => Number(d.get("titres") ?? 0) > 0 && typeof d.get("fin") === "string")
      .map((d) => ({ fin: d.get("fin") as string, montant: Number(d.get("titres")) }));
    const caisse = cash.docs.map((d) => ({ id: d.id, date: d.get("date") as string, amount: (d.get("cb") as number) ?? 0 }));
    const lignes = bank.docs.map((d) => {
      const valeur = d.get("valeur") as string | undefined;
      return { id: d.id, date: d.get("date") as string, amount: d.get("montant") as number, libelle: (d.get("libelle") as string) ?? "", ...(valeur ? { valeur } : {}) };
    });
    // Journées où la caisse a des titres-restaurant ou « autres » à part de la CB (compteurs) : dit si la CB les inclut.
    const modes = (m: string) => {
      const docs = cash.docs.filter((d) => String(d.get("date")).startsWith(m));
      return { joursTR: docs.filter((d) => Number(d.get("ticketsResto") ?? 0) > 0).length, joursAutres: docs.filter((d) => Number(d.get("autres") ?? 0) > 0).length };
    };
    out[r.id] = Object.fromEntries(mois.map((m) => [m, { ...bilanCB(m, caisse, lignes, undefined, titresUber), modesCaisse: modes(m) }]));
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
  const totalz: Record<string, unknown> = {};
  if (q.get("totalz") === "1") {
    for (const r of RESTAURANTS) {
      if (seul && r.id !== seul) continue;
      const docs = await adminDb()
        .collection(`restaurants/${r.id}/cashEntries`)
        .where("date", ">=", `${mois[0]}-01`)
        .where("date", "<=", `${mois[mois.length - 1]}-31`)
        .get();
      const b = { zLus: 0, avantEcart: 0, apresEcart: 0, apresOk: 0, sansTotal: 0, ligneEnTrop: 0, tropPercu: 0, corriges: 0 };
      const libellesAutres: Record<string, number> = {};
      const ecarts: string[] = [];
      for (const d of docs.docs) {
        const paiements = d.get("paiements") as LignePaiement[] | undefined;
        if (!Array.isArray(paiements) || !paiements.length) continue;
        b.zLus++;
        const total = d.get("total") as number | undefined;
        const date = d.get("date") as string;
        for (const p of paiements) if (p.categorie === "autres" || categorie(p.libelle) === "tropPercu") libellesAutres[p.libelle] = (libellesAutres[p.libelle] ?? 0) + 1;
        if (total === undefined) b.sansTotal++;
        else {
          const avant = paiements.reduce((x, p) => x + p.montant, 0);
          if (Math.abs(avant - total) > 1) b.avantEcart++;
          const c = controleTotal({ dateTicket: date, paiements, total });
          if (c.horsTotal.length) b.tropPercu++;
          if (c.statut === "ok") b.apresOk++;
          else {
            b.apresEcart++;
            if (c.ligneEnTrop) b.ligneEnTrop++;
            ecarts.push(date);
            console.log("controle-cb totalz", r.id, JSON.stringify({ date, somme: c.somme, total, ecart: c.ecart, lignes: paiements.map((p) => [p.libelle, p.montant, p.categorie]) }));
          }
        }
        const nouveaux = paiements.map((p) => ({ ...p, categorie: categorie(p.libelle) }));
        if (q.get("corriger") === "1" && nouveaux.some((p, i) => p.categorie !== paiements[i].categorie)) {
          const t = totaux(nouveaux);
          await d.ref.update({ paiements: nouveaux, cb: t.cb, especes: t.especes, ticketsResto: t.ticketsResto, autres: t.autres, uber: t.uber });
          b.corriges++;
        }
      }
      console.log("controle-cb totalz", r.id, JSON.stringify({ libellesAutres, ecarts }));
      totalz[r.id] = { ...b, ecarts };
    }
  }
  // &incoherences=1 : recalcule la liste de l'accueil ; seulement des compteurs par type dans la réponse publique.
  const incoherences: Record<string, unknown> = {};
  if (q.get("incoherences") === "1") {
    for (const r of RESTAURANTS) {
      if (seul && r.id !== seul) continue;
      const b = await majIncoherences(r.id);
      const parType: Record<string, number> = {};
      for (const x of b.liste) parType[x.type] = (parType[x.type] ?? 0) + 1;
      const parMois: Record<string, number> = {};
      for (const x of b.liste) parMois[x.date.slice(0, 7)] = (parMois[x.date.slice(0, 7)] ?? 0) + 1;
      // Causes et écarts relatifs (ratios, jamais de montant) pour régler les seuils.
      const causes = b.liste.filter((x) => x.raison || x.part !== undefined).map((x) => [x.type, x.raison ?? "", x.part ?? null]);
      incoherences[r.id] = { depuis: b.depuis, total: b.liste.length, parType, parMois, attente: b.attente.length, causes };
    }
  }
  // Sérialisé ici pour que toute erreur passe par le message ci-dessus.
  return new Response(
    JSON.stringify({ ...(Object.keys(totalz).length ? { totalz } : {}), ...(Object.keys(releve).length ? { releve } : {}), ...(Object.keys(incoherences).length ? { incoherences } : {}), ...out }),
    { headers: { "content-type": "application/json" } },
  );
}
