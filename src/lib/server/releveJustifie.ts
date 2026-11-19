import "server-only";
import { justifierReleve, resumerMois, type EntreeCaisseReleve, type LigneJustifiee, type ResumeMois } from "@/lib/justification";
import type { RestaurantId } from "@/lib/restaurants";
import type { VersementUber } from "@/lib/ticketZ";
import type { BankTransaction, Invoice, Supplier, WithId } from "@/lib/types";
import { adminDb } from "@/lib/server/admin";

const decale = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const aujourdhui = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const ajoutMois = (mois: string, n: number) => {
  const [y, m] = mois.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

/** Recalcul automatique au plus une fois par jour (≈ 3 500 lectures pour Manin : quota Firestore gratuit). */
export const INTERVALLE_RELEVE_JUSTIFIE = 20 * 3600_000;
/** Après un relevé bancaire qui apporte des opérations, au plus toutes les 10 h. */
export const INTERVALLE_RELEVE_NOUVELLES = 10 * 3600_000;

/** Index lu par la page « Relevé de compte » et l'accueil : settings/releve. */
export interface IndexReleve {
  le: number;
  debut?: string;
  fin?: string;
  mois: ResumeMois[];
}

/** Un document par mois : settings/releve-AAAA-MM (la page ne lit que le mois affiché). */
export interface MoisReleve {
  le: number;
  mois: string;
  lignes: LigneJustifiee[];
  groupesCB: ReturnType<typeof justifierReleve>["groupesCB"];
}

export const docMois = (mois: string) => `releve-${mois}`;

/**
 * Justifie chaque ligne du relevé bancaire du restaurant (tout l'historique) et range le résultat par mois dans
 * settings/releve-AAAA-MM, plus un index settings/releve. Lecture seule de la banque : aucune opération n'est créée.
 */
export async function majReleveJustifie(rid: RestaurantId): Promise<IndexReleve> {
  const home = adminDb().doc(`restaurants/${rid}`);
  const today = aujourdhui();
  const bank = await home.collection("bankTransactions").get();
  const transactions = bank.docs.map((d) => ({ id: d.id, ...(d.data() as BankTransaction) })) as WithId<BankTransaction>[];
  if (!transactions.length) {
    const vide: IndexReleve = { le: Date.now(), mois: [] };
    await home.collection("settings").doc("releve").set(vide);
    return vide;
  }
  const debut = transactions.reduce((m, t) => (t.date < m ? t.date : m), "9999-12-31");
  const fin = transactions.reduce((m, t) => (t.date > m ? t.date : m), "");
  // Factures : jusqu'à 3 mois avant le relevé (une facture d'août est payée en septembre ou octobre).
  const depuisFactures = ajoutMois(debut.slice(0, 7), -3);
  const [invoices, suppliers, cash, uber, employes, app] = await Promise.all([
    home.collection("invoices").where("mois", ">=", depuisFactures).get(),
    home.collection("suppliers").get(),
    home.collection("cashEntries").where("date", ">=", decale(debut, -21)).get(),
    home.collection("uberPayouts").where("date", ">=", decale(debut, -10)).get(),
    home.collection("employees").select("nom", "prenom").get(),
    home.collection("settings").doc("app").get(),
  ]);
  const r = justifierReleve({
    today,
    bank: transactions,
    invoices: invoices.docs.map((d) => ({ id: d.id, ...(d.data() as Invoice) })),
    suppliers: suppliers.docs.map((d) => ({ id: d.id, ...(d.data() as Supplier) })),
    cash: cash.docs.map((d) => ({
      id: d.id,
      date: d.get("date") as string,
      cb: Number(d.get("cb") ?? 0),
      especes: Number(d.get("especes") ?? 0),
      ...(d.get("uber") !== undefined ? { uber: Number(d.get("uber")) } : {}),
    })) as EntreeCaisseReleve[],
    versementsUber: uber.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<VersementUber, "id">) })),
    employes: employes.docs.map((d) => ({ nom: String(d.get("nom") ?? ""), prenom: String(d.get("prenom") ?? "") })),
    horsFournisseurs: ((app.get("horsFournisseurs") as string[] | undefined) ?? []).filter((x) => typeof x === "string"),
  });
  const le = Date.now();
  const parMois = new Map<string, LigneJustifiee[]>();
  for (const l of r.lignes) parMois.set(l.date.slice(0, 7), [...(parMois.get(l.date.slice(0, 7)) ?? []), l]);
  const resumes: ResumeMois[] = [];
  const batch = adminDb().batch();
  for (const [mois, lignes] of [...parMois].sort(([a], [b]) => a.localeCompare(b))) {
    const groupesCB = Object.fromEntries(Object.entries(r.groupesCB).filter(([k]) => lignes.some((l) => l.cb === k)));
    const doc: MoisReleve = { le, mois, lignes: sansIndefinis(lignes), groupesCB };
    batch.set(home.collection("settings").doc(docMois(mois)), doc);
    resumes.push(resumerMois(mois, lignes));
  }
  const index: IndexReleve = { le, debut, fin, mois: resumes };
  batch.set(home.collection("settings").doc("releve"), index);
  await batch.commit();
  return index;
}

/** Firestore refuse les champs « undefined ». */
const sansIndefinis = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Recalcule après un relevé bancaire qui a apporté des lignes (au plus toutes les 10 h), sinon une fois par jour. Ne fait jamais échouer l'appelant. */
export async function majReleveSiBesoin(rid: RestaurantId, nouvelles: boolean): Promise<{ lignes: number } | { erreur: string } | null> {
  try {
    const le = (await adminDb().doc(`restaurants/${rid}/settings/releve`).get()).get("le") as number | undefined;
    const age = le ? Date.now() - le : Infinity;
    if (age < (nouvelles ? INTERVALLE_RELEVE_NOUVELLES : INTERVALLE_RELEVE_JUSTIFIE)) return null;
    const i = await majReleveJustifie(rid);
    return { lignes: i.mois.reduce((s, m) => s + m.lignes, 0) };
  } catch (e) {
    return { erreur: (e as Error).message.slice(0, 200) };
  }
}
