import "server-only";
import { aContester, type Contestation } from "@/lib/contestations";
import type { RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { colContestations, importerLignes, type ResultatImport } from "@/lib/server/contestationsStore";
import { jetonBoite } from "@/lib/server/mailSync";
import { chiffrer, dechiffrer, type Chiffre } from "@/lib/server/secretBox";
import { contester, lireMontant, lireProblemes, ouvrirUber, UberError, type ConfigUber, type DiagnosticUber, type SessionUber } from "@/lib/server/uberEatsBot";

/** restaurants/{rid}/private/ubereats : identifiants (mot de passe et session chiffrés), réglages et état du robot. */
export const refUber = (rid: RestaurantId) => adminDb().doc(`restaurants/${rid}/private/ubereats`);

export interface EtatRobot {
  le: number;
  ok: boolean;
  message: string;
  besoin?: string;
}

async function config(rid: RestaurantId): Promise<{ cfg: ConfigUber; modeAuto: boolean }> {
  const d = (await refUber(rid).get()).data();
  if (!d?.email || !d?.motDePasse) throw new UberError("Identifiants Uber Eats non renseignés : ajoute-les dans Réglages.", undefined, "identifiants");
  let motDePasse: string;
  try {
    motDePasse = dechiffrer(d.motDePasse as Chiffre);
  } catch {
    throw new UberError("Mot de passe Uber Eats illisible (clé du serveur changée) : ressaisis-le dans Réglages.", undefined, "identifiants");
  }
  let cookies: string | undefined;
  try {
    cookies = d.session ? dechiffrer(d.session as Chiffre) : undefined;
  } catch {
    cookies = undefined;
  }
  return {
    cfg: {
      email: d.email,
      motDePasse,
      urlProblemes: d.urlProblemes || undefined,
      boutique: d.boutique || undefined,
      cookies,
      jetonGmail: () => jetonBoite(rid),
    },
    modeAuto: d.modeAuto === true,
  };
}

async function avecSession<T>(rid: RestaurantId, travail: (s: SessionUber, cfg: ConfigUber, modeAuto: boolean) => Promise<T>): Promise<T> {
  const { cfg, modeAuto } = await config(rid);
  const s = await ouvrirUber(cfg);
  try {
    return await travail(s, cfg, modeAuto);
  } finally {
    const cookies = await s.fermer();
    if (cookies.length > 2) await refUber(rid).set({ session: chiffrer(cookies), sessionLe: Date.now() }, { merge: true });
  }
}

async function noterEtat(rid: RestaurantId, etat: EtatRobot) {
  await refUber(rid).set({ dernierPassage: etat }, { merge: true });
}

const aujourdhui = () => new Date().toISOString().slice(0, 10);

export interface ResultatReleve extends ResultatImport {
  lues: number;
  montantsLus: number;
  contestees: string[];
  echecs: { id: string; message: string }[];
  diagnostic?: DiagnosticUber;
}

/**
 * Passage du robot : lit la liste des problèmes, la range dans le suivi, lit le montant des nouvelles
 * commandes à contester, puis (mode automatique) conteste celles qui sont « à contester ».
 */
export async function releverUber(rid: RestaurantId, { budgetMs = 100_000, contesterAuto }: { budgetMs?: number; contesterAuto?: boolean } = {}): Promise<ResultatReleve> {
  const debut = Date.now();
  const reste = () => budgetMs - (Date.now() - debut);
  try {
    const r = await avecSession(rid, async (s, cfg, modeAuto) => {
      const { lignes, diagnostic } = await lireProblemes(s, cfg);
      const imp = await importerLignes(rid, lignes, "robot");
      const out: ResultatReleve = { ...imp, lues: lignes.length, montantsLus: 0, contestees: [], echecs: [], diagnostic };

      const col = colContestations(rid);
      const fiches = (await col.where("issue", "==", "a_contester").get()).docs.map((d) => ({ id: d.id, ...(d.data() as Contestation) }));
      for (const f of fiches.filter((x) => x.montant === undefined)) {
        if (reste() < 25_000) break;
        const m = await lireMontant(s, cfg, f.commande).catch(() => null);
        if (m) {
          await col.doc(f.id).update({ montant: m, updatedAt: Date.now() });
          out.montantsLus++;
        }
      }

      if (contesterAuto ?? modeAuto) {
        for (const f of fiches.filter((x) => aContester(x.etatUber))) {
          if (reste() < 30_000) break;
          try {
            const c = await contester(s, cfg, f.commande, f.commentaire ?? "", false);
            if (c.envoyee) {
              await col.doc(f.id).update({ issue: "contestee", dateContestation: aujourdhui(), contesteePar: "robot", ...(c.montant && f.montant === undefined ? { montant: c.montant } : {}), updatedAt: Date.now() });
              out.contestees.push(f.id);
            } else {
              await col.doc(f.id).update({ erreurRobot: { message: "Envoi non confirmé par Uber", le: Date.now() } });
              out.echecs.push({ id: f.id, message: "Envoi non confirmé par Uber" });
            }
          } catch (e) {
            await col.doc(f.id).update({ erreurRobot: { message: (e as Error).message, le: Date.now() } });
            out.echecs.push({ id: f.id, message: (e as Error).message });
          }
        }
      }
      return out;
    });
    await noterEtat(rid, {
      le: Date.now(),
      ok: true,
      message: `${r.lues} commande(s) lue(s), ${r.ajoutees} nouvelle(s), ${r.contestees.length} contestée(s)${r.echecs.length ? `, ${r.echecs.length} échec(s)` : ""}.`,
    });
    return r;
  } catch (e) {
    const u = e instanceof UberError ? e : new UberError((e as Error).message);
    await noterEtat(rid, { le: Date.now(), ok: false, message: u.message, ...(u.besoin ? { besoin: u.besoin } : {}) });
    throw u;
  }
}

/** Conteste une fiche précise (bouton de la page). essai = remplit sans envoyer. */
export async function contesterFiche(rid: RestaurantId, id: string, essai: boolean) {
  const col = colContestations(rid);
  const snap = await col.doc(id).get();
  if (!snap.exists) throw new UberError("Fiche introuvable.");
  const f = snap.data() as Contestation;
  try {
    const r = await avecSession(rid, (s, cfg) => contester(s, cfg, f.commande, f.commentaire ?? "", essai));
    if (!essai) {
      if (r.envoyee) {
        await col.doc(id).update({
          issue: "contestee",
          dateContestation: aujourdhui(),
          contesteePar: "robot",
          erreurRobot: (await import("firebase-admin/firestore")).FieldValue.delete(),
          ...(r.montant && f.montant === undefined ? { montant: r.montant } : {}),
          updatedAt: Date.now(),
        });
      } else {
        await col.doc(id).update({ erreurRobot: { message: "Envoi non confirmé par Uber", le: Date.now() } });
      }
    }
    return r;
  } catch (e) {
    if (!essai) await col.doc(id).update({ erreurRobot: { message: (e as Error).message, le: Date.now() } });
    throw e;
  }
}
