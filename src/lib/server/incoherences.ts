import "server-only";
import { debutParDefaut, listerIncoherences, type BilanIncoherences, type EntreeCaisse } from "@/lib/incoherences";
import type { RestaurantId } from "@/lib/restaurants";
import type { VersementUber } from "@/lib/ticketZ";
import { adminDb } from "@/lib/server/admin";

const decale = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const aujourdhui = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });

/** Recalcul au plus toutes les 12 h sans donnée nouvelle (quota de lectures Firestore gratuit). */
export const INTERVALLE_INCOHERENCES = 12 * 3600_000;

/**
 * Recalcule les incohérences d'un restaurant (mois précédent + mois en cours) et les range dans settings/incoherences :
 * l'accueil ne lit que ce document. ~1 000 lectures par calcul, d'où un appel seulement après un relevé (banque,
 * L'Addition) ou à la demande.
 */
export async function majIncoherences(rid: RestaurantId): Promise<BilanIncoherences> {
  const home = adminDb().doc(`restaurants/${rid}`);
  const today = aujourdhui();
  const depuis = debutParDefaut(today);
  // 10 jours avant : les remises du début de période se rattachent aux journées d'avant.
  const lecture = decale(depuis, -10);
  const [cash, bank, uber, uberJours] = await Promise.all([
    home.collection("cashEntries").where("date", ">=", lecture).get(),
    home.collection("bankTransactions").where("date", ">=", lecture).get(),
    home.collection("uberPayouts").where("date", ">=", lecture).get(),
    home.collection("uberJours").where("date", ">=", depuis).get(),
  ]);
  const bilan = listerIncoherences({
    today,
    depuis,
    cash: cash.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<EntreeCaisse, "id">) })),
    bank: bank.docs.map((d) => {
      const valeur = d.get("valeur") as string | undefined;
      return { id: d.id, date: d.get("date") as string, amount: d.get("montant") as number, libelle: (d.get("libelle") as string) ?? "", ...(valeur ? { valeur } : {}) };
    }),
    versementsUber: uber.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<VersementUber, "id">) })),
    uberJours: uberJours.docs.map((d) => ({
      date: d.get("date") as string,
      commandes: Number(d.get("commandes") ?? 0),
      ventes: Number(d.get("ventes") ?? 0),
      ...(d.get("partiel") ? { partiel: true } : {}),
    })),
  });
  // Liste bornée : le document reste petit (lu à chaque ouverture de l'accueil).
  await home.collection("settings").doc("incoherences").set({ ...bilan, total: bilan.liste.length, liste: bilan.liste.slice(0, 60), attente: bilan.attente.slice(0, 20) });
  return bilan;
}

/** Recalcule si des données sont arrivées, ou si le dernier calcul a plus de 12 h. Ne fait jamais échouer l'appelant. */
export async function majIncoherencesSiBesoin(rid: RestaurantId, nouvelles: boolean): Promise<{ total: number; attente: number } | { erreur: string } | null> {
  try {
    if (!nouvelles) {
      const le = (await adminDb().doc(`restaurants/${rid}/settings/incoherences`).get()).get("le") as number | undefined;
      if (le && Date.now() - le < INTERVALLE_INCOHERENCES) return null;
    }
    const b = await majIncoherences(rid);
    return { total: b.liste.length, attente: b.attente.length };
  } catch (e) {
    return { erreur: (e as Error).message.slice(0, 200) };
  }
}
