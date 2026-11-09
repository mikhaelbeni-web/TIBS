import { safeEqual } from "@/lib/ingest";
import { bodyText, emailOf, gmailQuery, header, mergeRules, pdfAttachments } from "@/lib/mail";
import { RESTAURANTS } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { chiffrerPour } from "@/lib/server/chiffrer";
import { getMessage, listMessageIds, refreshAccessToken } from "@/lib/server/google";
import { syncMail } from "@/lib/server/mailSync";
import { chercherDansBoites, passeReleves } from "@/lib/server/relevesPasse";
import { validerAutomatiquement } from "@/lib/server/autoValider";
import { isRestaurantId } from "@/lib/restaurants";
import { FieldValue } from "firebase-admin/firestore";
import { rapprocher } from "@/lib/rapprochementFournisseurs";
import type { BankTransaction, Invoice, Supplier, WithId } from "@/lib/types";

export const maxDuration = 300;

const MOIS_2026 = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
const finMois = (m: string) => {
  const [y, n] = m.split("-").map(Number);
  return new Date(Date.UTC(y, n, 0)).toISOString().slice(0, 10);
};

/**
 * GET /api/cron/fournisseurs?action=mesure[&cle=…] (Authorization: Bearer CRON_SECRET), lancé à la main par le
 * workflow « Factures fournisseurs depuis janvier ». Lecture seule.
 * En clair : des compteurs seulement (le journal du workflow est public).
 * &cle=<clé publique RSA, SPKI DER base64> : le détail (fournisseurs, débits bancaires, totaux) est renvoyé chiffré
 * pour cette clé, illisible sans la clé privée.
 *
 * action=rattrapage&r=19e&mois=2026-01 : relit les mails de ce mois (lot limité à ~4 min ; relancer tant que
 * « restants » > 0). Lecture des PDF sur le budget de rattrapage (settings/mail.rattrapage), jamais sur le budget
 * mensuel. &valider=1 : passe de validation automatique à la fin du lot.
 * action=budget&r=19e&usd=100&modele=opus : fixe le budget de rattrapage (dépense déjà faite conservée).
 * action=pointer&r=19e : marque payées les factures retrouvées au centime sur le relevé (même calcul que l'onglet
 * « Banque depuis janvier »). Compteurs seulement en clair.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const q = new URL(request.url).searchParams;
    const action = q.get("action") ?? "mesure";
    if (action === "rattrapage" || action === "budget") return await rattraper(action, q);
    if (action === "pointer") return await pointer(q);
    if (action === "releves") return await mesurerReleves(q.get("cle"));
    if (action === "calibrage") return await calibrer(q.get("cle"));
    if (action === "releves-passe") {
      const res: Record<string, unknown> = {};
      for (const r of RESTAURANTS) res[r.id] = await passeReleves(r.id, { budgetMs: 130_000, force: true, maxLectures: 25 }).catch((e) => ({ erreur: (e as Error).message.slice(0, 200) }));
      return Response.json(res);
    }
    const cle = q.get("cle");
    const compteurs: Record<string, unknown> = {};
    const detail: Record<string, unknown> = {};
    for (const r of RESTAURANTS) {
      const home = adminDb().doc(`restaurants/${r.id}`);
      const [suppliers, invoices, bank, inbox, mailStatus, gmail] = await Promise.all([
        home.collection("suppliers").get(),
        home.collection("invoices").get(),
        home.collection("bankTransactions").get(),
        home.collection("inbox").select("statut", "item.kind", "item.dateFacture", "item.fournisseur", "item.montantTTC", "doutes", "auto").get(),
        home.collection("settings").doc("mail").get(),
        home.collection("private").doc("gmail").get(),
      ]);
      const parMois = (dates: string[]) => {
        const o: Record<string, number> = {};
        for (const d of dates) o[d.slice(0, 7)] = (o[d.slice(0, 7)] ?? 0) + 1;
        return Object.fromEntries(Object.entries(o).sort());
      };
      const bankDates = bank.docs.map((d) => String(d.get("date") ?? "")).filter(Boolean).sort();
      // Mails candidats (même requête que le relevé) par mois de 2026, et combien sont déjà journalisés.
      const mails: Record<string, { candidats: number; journalises: number; ignores: number }> = {};
      const refresh = gmail.get("refreshToken") as string | undefined;
      if (refresh) {
        const token = await refreshAccessToken(refresh);
        const rules = mergeRules(mailStatus.get("regles"));
        for (const m of MOIS_2026) {
          if (`${m}-01` > new Date().toISOString().slice(0, 10)) break;
          const ids = await listMessageIds(token, gmailQuery(0, rules, { du: `${m}-01`, au: finMois(m) }), 3000);
          let journalises = 0;
          let ignores = 0;
          for (let i = 0; i < ids.length; i += 300) {
            const logs = await adminDb().getAll(...ids.slice(i, i + 300).map((id) => home.collection("mailLog").doc(id)));
            for (const l of logs) {
              if (!l.exists) continue;
              journalises++;
              if (l.get("type") === "ignore") ignores++;
            }
          }
          mails[m] = { candidats: ids.length, journalises, ignores };
        }
      }
      const inboxStat: Record<string, number> = {};
      for (const d of inbox.docs) {
        const k = `${d.get("item.kind")}:${d.get("statut")}:${String(d.get("item.dateFacture") ?? "").slice(0, 7) || "?"}`;
        inboxStat[k] = (inboxStat[k] ?? 0) + 1;
      }
      compteurs[r.id] = {
        fournisseurs: suppliers.size,
        factures: parMois(invoices.docs.map((d) => String(d.get("dateFacture") ?? ""))),
        banque: { operations: bank.size, premiere: bankDates[0], derniere: bankDates.at(-1), parMois: parMois(bankDates) },
        mails,
        inbox: inboxStat,
      };
      if (cle) {
        detail[r.id] = {
          fournisseurs: suppliers.docs.map((d) => ({ id: d.id, nom: d.get("nom"), paiement: d.get("paiement"), libelleBanque: d.get("libelleBanque"), email: d.get("email"), iban: d.get("iban") ? "oui" : undefined })),
          factures: invoices.docs.map((d) => ({ s: d.get("supplierId"), n: d.get("supplierNom"), num: d.get("numero"), d: d.get("dateFacture"), ttc: d.get("montantTTC"), st: d.get("statut"), auto: d.get("auto") })),
          debits: bank.docs
            .filter((d) => Number(d.get("montant")) < 0)
            .map((d) => ({ d: d.get("date"), l: d.get("libelle"), m: d.get("montant"), x: d.get("details"), t: d.get("type"), src: d.get("source") ?? "fichier" })),
          credits: bank.docs.filter((d) => Number(d.get("montant")) > 0).length,
          inbox: inbox.docs
            .filter((d) => d.get("item.kind") === "facture" && d.get("statut") === "a_verifier")
            .map((d) => ({ f: d.get("item.fournisseur"), d: d.get("item.dateFacture"), ttc: d.get("item.montantTTC"), doutes: d.get("doutes") })),
        };
      }
    }
    return Response.json({ compteurs, ...(cle ? { chiffre: chiffrerPour(cle, detail) } : {}) });
  } catch (e) {
    const err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    return Response.json({ erreur: err.slice(0, 400) }, { status: 500 });
  }
}

async function rattraper(action: string, q: URLSearchParams) {
  const rid = q.get("r");
  if (!isRestaurantId(rid)) return Response.json({ erreur: "r=19e ou r=17e attendu" }, { status: 400 });
  const statusRef = adminDb().doc(`restaurants/${rid}/settings/mail`);
  if (action === "budget") {
    const usd = Number(q.get("usd"));
    const modele = q.get("modele");
    if (!Number.isFinite(usd) || usd < 0 || usd > 300) return Response.json({ erreur: "usd entre 0 et 300" }, { status: 400 });
    if (modele && !["opus", "sonnet", "haiku"].includes(modele)) return Response.json({ erreur: "modele inconnu" }, { status: 400 });
    await statusRef.set({ rattrapage: { budgetUsd: usd, ...(modele ? { modele } : {}), maj: Date.now() } }, { merge: true });
    const r = (await statusRef.get()).get("rattrapage");
    return Response.json({ r: rid, budgetUsd: r?.budgetUsd, modele: r?.modele, coutUsd: r?.coutUsd ?? 0, lectures: r?.lectures ?? 0 });
  }
  const mois = q.get("mois") ?? "";
  if (!/^2026-(0[1-9]|1[0-2])$/.test(mois)) return Response.json({ erreur: "mois=2026-MM attendu" }, { status: 400 });
  const res = await syncMail(rid, { periode: { du: `${mois}-01`, au: finMois(mois) }, rattrapage: true, budgetMs: 230_000 });
  const auto = q.get("valider") === "1" ? await validerAutomatiquement(rid).catch((e) => ({ erreur: (e as Error).message })) : undefined;
  if (res.status === "ok" && !res.incomplet) await statusRef.set({ rattrapage: { moisFaits: FieldValue.arrayUnion(mois) } }, { merge: true });
  const r = (await statusRef.get()).get("rattrapage");
  // Compteurs seulement : le journal du workflow est public.
  return Response.json({
    r: rid,
    mois,
    status: res.status,
    vus: res.messagesVus,
    nouveaux: res.nouveaux,
    ignores: res.ignores,
    doublons: res.doublons,
    erreurs: res.erreurs,
    releves: res.releves ?? 0,
    uberAuto: res.uberAuto ?? 0,
    lectures: res.lectures ?? 0,
    restants: res.restants ?? 0,
    incomplet: res.incomplet,
    limite: res.limite ?? null,
    budget: { usd: r?.budgetUsd ?? 0, depense: Math.round(Number(r?.coutUsd ?? 0) * 100) / 100 },
    ...(auto ? { auto: "erreur" in auto ? { erreur: auto.erreur.slice(0, 200) } : { valides: auto.valides, enDoute: auto.enDoute, ignores: auto.ignores ?? 0 } } : {}),
    ...(res.message ? { message: res.message.slice(0, 200) } : {}),
  });
}

async function pointer(q: URLSearchParams) {
  const rid = q.get("r");
  if (!isRestaurantId(rid)) return Response.json({ erreur: "r=19e ou r=17e attendu" }, { status: 400 });
  const home = adminDb().doc(`restaurants/${rid}`);
  const [sup, inv, bank, app] = await Promise.all([
    home.collection("suppliers").get(),
    home.collection("invoices").get(),
    home.collection("bankTransactions").get(),
    home.collection("settings").doc("app").get(),
  ]);
  const avec = <T,>(s: FirebaseFirestore.QuerySnapshot) => s.docs.map((d) => ({ id: d.id, ...(d.data() as T) }));
  const aujourdhui = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
  const r = rapprocher(avec<Supplier>(sup) as WithId<Supplier>[], avec<Invoice>(inv) as WithId<Invoice>[], avec<BankTransaction>(bank) as WithId<BankTransaction>[], {
    depuis: "2026-01",
    aujourdhui,
    horsFournisseurs: (app.get("horsFournisseurs") as string[] | undefined) ?? [],
  });
  for (let i = 0; i < r.aPointer.length; i += 400) {
    const batch = adminDb().batch();
    for (const p of r.aPointer.slice(i, i + 400)) batch.update(home.collection("invoices").doc(p.factureId), { statut: "payee", datePaiement: p.date, paiement: p.mode });
    await batch.commit();
  }
  const etats: Record<string, number> = {};
  for (const b of r.fournisseurs) for (const l of b.mois) if (l.etat !== "rien") etats[l.etat] = (etats[l.etat] ?? 0) + 1;
  return Response.json({
    r: rid,
    pointees: r.aPointer.length,
    fournisseurs: r.fournisseurs.length,
    moisParEtat: etats,
    remises: { total: r.remises.length, expliquees: r.remises.filter((x) => x.groupes).length },
    tiersSansFiche: r.sansFournisseur.length,
  });
}

/** Mails qui ressemblent à un relevé / récapitulatif fournisseur (hors Uber et banque). */
const REQUETE_RELEVES =
  'after:2026/01/01 -in:sent -in:spam -in:trash -from:me -from:uber.com -from:caisse-epargne.fr ' +
  '(subject:(relevé OR releve OR récapitulatif OR recapitulatif OR récap OR recap OR "situation de compte" OR "état de compte" OR "etat de compte" OR échéancier OR "relevé de factures" OR "relevé de compte") ' +
  "OR filename:(releve OR relevé OR recap OR recapitulatif OR situation))";

/**
 * action=releves&cle=… : relevés fournisseurs déjà rangés (releves) et mails qui y ressemblent dans chaque boîte,
 * avec ce que le relevé des mails en a fait (mailLog). Détail chiffré seulement ; en clair, des compteurs.
 */
async function mesurerReleves(cle: string | null) {
  const compteurs: Record<string, unknown> = {};
  const detail: Record<string, unknown> = {};
  for (const r of RESTAURANTS) {
    const home = adminDb().doc(`restaurants/${r.id}`);
    const [releves, gmail] = await Promise.all([home.collection("releves").get(), home.collection("private").doc("gmail").get()]);
    const mails: Record<string, unknown>[] = [];
    const refresh = gmail.get("refreshToken") as string | undefined;
    if (refresh) {
      const token = await refreshAccessToken(refresh);
      const ids = await listMessageIds(token, REQUETE_RELEVES, 200);
      const logs = ids.length ? await adminDb().getAll(...ids.map((id) => home.collection("mailLog").doc(id))) : [];
      for (const [i, id] of ids.entries()) {
        const m = await getMessage(token, id).catch(() => null);
        if (!m) continue;
        mails.push({
          id,
          de: emailOf(header(m, "From")),
          objet: header(m, "Subject").slice(0, 200),
          date: header(m, "Date"),
          pdfs: pdfAttachments(m).map((p) => p.filename),
          corps: bodyText(m).replace(/\s+/g, " ").slice(0, 1500),
          log: logs[i]?.exists ? { type: logs[i].get("type"), elements: logs[i].get("elements") } : null,
        });
      }
    }
    compteurs[r.id] = { releves: releves.size, mailsRessemblants: mails.length, journalises: mails.filter((m) => m.log).length };
    if (cle) detail[r.id] = { releves: releves.docs.map((d) => ({ id: d.id, ...d.data() })), mails };
  }
  return Response.json({ compteurs, ...(cle ? { chiffre: chiffrerPour(cle, detail) } : {}) });
}

/**
 * action=calibrage&cle=… : la recherche par numéro dans Gmail retrouve-t-elle les factures qu'on a bien reçues
 * par mail ? Pour chaque fournisseur qui envoie des relevés, jusqu'à 6 factures venues d'un mail sont cherchées.
 * Détail chiffré ; en clair, le taux global seulement.
 */
async function calibrer(cle: string | null) {
  const detail: Record<string, unknown> = {};
  let total = 0;
  let trouvees = 0;
  for (const r of RESTAURANTS) {
    const home = adminDb().doc(`restaurants/${r.id}`);
    const [releves, invoices] = await Promise.all([home.collection("releves").select("fournisseur", "supplierId").get(), home.collection("invoices").get()]);
    const noms = new Set(releves.docs.map((d) => String(d.get("fournisseur") ?? "").toLowerCase()));
    const ids = new Set(releves.docs.map((d) => d.get("supplierId")).filter(Boolean));
    const parFournisseur = new Map<string, string[]>();
    for (const d of invoices.docs) {
      const nom = String(d.get("supplierNom") ?? "");
      if (!d.get("inboxId") || !d.get("numero") || !(ids.has(d.get("supplierId")) || noms.has(nom.toLowerCase()))) continue;
      const l = parFournisseur.get(nom) ?? [];
      if (l.length < 6) l.push(String(d.get("numero")));
      parFournisseur.set(nom, l);
    }
    const res: Record<string, { cherchees: string[]; trouvees: string[] }> = {};
    for (const [nom, numeros] of parFournisseur) {
      const x = await chercherDansBoites(numeros, { source: { messageId: "" } });
      res[nom] = { cherchees: numeros, trouvees: Object.keys(x.trouvees) };
      total += x.cherchees.length;
      trouvees += Object.keys(x.trouvees).length;
    }
    detail[r.id] = res;
  }
  return Response.json({ total, trouvees, ...(cle ? { chiffre: chiffrerPour(cle, detail) } : {}) });
}
