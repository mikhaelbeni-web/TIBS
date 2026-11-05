import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { debutReleve, lignesDuCompte, sansDoublonsImport } from "@/lib/banque";
import type { RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { AccesExpire, configuree, operations } from "@/lib/server/enableBanking";

export interface CompteBanque {
  uid: string;
  nom: string;
  iban: string; // masqué
}

/** restaurants/{rid}/private/banque (serveur uniquement). */
export interface BanquePrivee {
  sessionId: string;
  banque: string;
  comptes: CompteBanque[];
  validUntil: string;
  connectePar: string;
  connecteLe: number;
}

export type BanqueSyncResult =
  | { status: "ok"; nouvelles: number; comptes: number; depuis: string }
  | { status: "non_connectee" | "non_configuree" }
  | { status: "expiree" | "erreur"; erreur: string };

/** Relève les opérations comptabilisées de chaque compte et ajoute les nouvelles dans bankTransactions. */
export async function syncBanque(rid: RestaurantId): Promise<BanqueSyncResult> {
  if (!configuree()) return { status: "non_configuree" };
  const db = adminDb();
  const home = db.doc(`restaurants/${rid}`);
  const priv = (await home.collection("private").doc("banque").get()).data() as BanquePrivee | undefined;
  if (!priv?.sessionId) return { status: "non_connectee" };
  const etatRef = home.collection("settings").doc("banque");
  const etat = (await etatRef.get()).data() ?? {};
  const depuis = debutReleve(etat.derniereOperation as string | undefined);

  try {
    const existantes = await home.collection("bankTransactions").where("date", ">=", depuis).get();
    const ids = new Set(existantes.docs.map((d) => d.id));
    const importees = existantes.docs.filter((d) => d.get("source") !== "banque").map((d) => ({ date: d.get("date") as string, montant: d.get("montant") as number }));

    let nouvelles = 0;
    let derniere = (etat.derniereOperation as string | undefined) ?? "";
    const now = Date.now();
    for (const c of priv.comptes) {
      const lignes = lignesDuCompte(c.uid, await operations(c.uid, depuis));
      for (const l of lignes) if (l.date > derniere) derniere = l.date;
      const aEcrire = sansDoublonsImport(lignes.filter((l) => !ids.has(l.id)), importees);
      for (let i = 0; i < aEcrire.length; i += 400) {
        const batch = db.batch();
        for (const l of aEcrire.slice(i, i + 400)) {
          batch.set(home.collection("bankTransactions").doc(l.id), {
            date: l.date,
            libelle: l.libelle,
            montant: l.montant,
            importId: "banque",
            source: "banque",
            compte: c.uid,
            ref: l.ref,
            createdAt: now,
          });
          ids.add(l.id);
        }
        await batch.commit();
      }
      nouvelles += aEcrire.length;
    }
    await etatRef.set(
      {
        dernierPassage: now,
        dernierResultat: { nouvelles, le: now },
        ...(derniere ? { derniereOperation: derniere } : {}),
        erreur: FieldValue.delete(),
        expiree: FieldValue.delete(),
      },
      { merge: true },
    );
    return { status: "ok", nouvelles, comptes: priv.comptes.length, depuis };
  } catch (e) {
    const msg = (e as Error).message;
    const expiree = e instanceof AccesExpire;
    await etatRef.set({ dernierPassage: Date.now(), erreur: msg, ...(expiree ? { expiree: true } : {}) }, { merge: true });
    return { status: expiree ? "expiree" : "erreur", erreur: msg };
  }
}
