import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { apparierImports, compterValeurs, debutReleve, lignesDuCompte, sansDoublonsImport } from "@/lib/banque";
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

/** Compteurs seulement (aucun montant ni libellé) : ils s'affichent dans le journal public du relevé. */
export type CompteursValeurs = ReturnType<typeof compterValeurs> & { completees: number };

export type BanqueSyncResult =
  | { status: "ok"; nouvelles: number; comptes: number; depuis: string; valeurs: CompteursValeurs }
  | { status: "non_connectee" | "non_configuree" }
  | { status: "expiree" | "erreur"; erreur: string };

/** Change quand il faut relire 90 jours pour compléter les opérations déjà enregistrées. */
const VERSION_VALEURS = 1;

/** Relève les opérations comptabilisées de chaque compte et ajoute les nouvelles dans bankTransactions. */
export async function syncBanque(rid: RestaurantId): Promise<BanqueSyncResult> {
  if (!configuree()) return { status: "non_configuree" };
  const db = adminDb();
  const home = db.doc(`restaurants/${rid}`);
  const priv = (await home.collection("private").doc("banque").get()).data() as BanquePrivee | undefined;
  if (!priv?.sessionId) return { status: "non_connectee" };
  const etatRef = home.collection("settings").doc("banque");
  const etat = (await etatRef.get()).data() ?? {};
  // Une fois : relire les 90 derniers jours pour donner leur date de valeur aux opérations déjà enregistrées.
  const rattrapageValeurs = etat.valeurs !== VERSION_VALEURS;
  const depuis = debutReleve(rattrapageValeurs ? undefined : (etat.derniereOperation as string | undefined));

  try {
    const existantes = await home.collection("bankTransactions").where("date", ">=", depuis).get();
    const ids = new Set(existantes.docs.map((d) => d.id));
    const sansValeur = new Set(existantes.docs.filter((d) => !d.get("valeur")).map((d) => d.id));
    const importeesDocs = existantes.docs.filter((d) => d.get("source") !== "banque");
    const importees = importeesDocs.map((d) => ({ date: d.get("date") as string, montant: d.get("montant") as number }));

    let nouvelles = 0;
    let completees = 0;
    let derniere = (etat.derniereOperation as string | undefined) ?? "";
    const toutes: { date: string; montant: number; libelle: string; valeur?: string }[] = [];
    const now = Date.now();
    for (const c of priv.comptes) {
      const lignes = lignesDuCompte(c.uid, await operations(c.uid, depuis));
      toutes.push(...lignes);
      for (const l of lignes) if (l.date > derniere) derniere = l.date;
      const aEcrire = sansDoublonsImport(lignes.filter((l) => !ids.has(l.id)), importees);
      // Date de valeur manquante : opérations de l'API déjà enregistrées, et lignes importées d'un fichier.
      const aCompleter = new Map<string, string>();
      for (const l of lignes) if (l.valeur && sansValeur.has(l.id)) aCompleter.set(l.id, l.valeur);
      const imports = importeesDocs
        .filter((d) => sansValeur.has(d.id))
        .map((d) => ({ id: d.id, date: d.get("date") as string, montant: d.get("montant") as number, libelle: d.get("libelle") as string }));
      for (const [id, l] of apparierImports(lignes, imports)) if (l.valeur) aCompleter.set(id, l.valeur);
      const ecritures = [
        ...aEcrire.map((l) => (b: FirebaseFirestore.WriteBatch) =>
          b.set(home.collection("bankTransactions").doc(l.id), {
            date: l.date,
            libelle: l.libelle,
            montant: l.montant,
            ...(l.valeur ? { valeur: l.valeur } : {}),
            importId: "banque",
            source: "banque",
            compte: c.uid,
            ref: l.ref,
            createdAt: now,
          }),
        ),
        ...[...aCompleter].map(([id, valeur]) => (b: FirebaseFirestore.WriteBatch) => b.update(home.collection("bankTransactions").doc(id), { valeur })),
      ];
      for (let i = 0; i < ecritures.length; i += 400) {
        const batch = db.batch();
        for (const e of ecritures.slice(i, i + 400)) e(batch);
        await batch.commit();
      }
      for (const l of aEcrire) ids.add(l.id);
      for (const id of aCompleter.keys()) sansValeur.delete(id);
      nouvelles += aEcrire.length;
      completees += aCompleter.size;
    }
    const valeurs = { ...compterValeurs(toutes), completees };
    await etatRef.set(
      {
        dernierPassage: now,
        dernierResultat: { nouvelles, le: now },
        ...(derniere ? { derniereOperation: derniere } : {}),
        valeurs: VERSION_VALEURS,
        erreur: FieldValue.delete(),
        expiree: FieldValue.delete(),
      },
      { merge: true },
    );
    return { status: "ok", nouvelles, comptes: priv.comptes.length, depuis, valeurs };
  } catch (e) {
    const msg = (e as Error).message;
    const expiree = e instanceof AccesExpire;
    await etatRef.set({ dernierPassage: Date.now(), erreur: msg, ...(expiree ? { expiree: true } : {}) }, { merge: true });
    return { status: expiree ? "expiree" : "erreur", erreur: msg };
  }
}
