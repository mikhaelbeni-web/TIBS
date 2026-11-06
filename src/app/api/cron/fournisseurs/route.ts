import { safeEqual } from "@/lib/ingest";
import { gmailQuery, mergeRules } from "@/lib/mail";
import { RESTAURANTS } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { chiffrerPour } from "@/lib/server/chiffrer";
import { listMessageIds, refreshAccessToken } from "@/lib/server/google";

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
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 16 || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return new Response("Unauthorized", { status: 401 });
  }
  try {
    const q = new URL(request.url).searchParams;
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
