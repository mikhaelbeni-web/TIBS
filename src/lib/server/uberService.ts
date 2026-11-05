import "server-only";
import { FieldValue } from "firebase-admin/firestore";
import { aContester, type Contestation } from "@/lib/contestations";
import type { RestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { colContestations, importerLignes, type ResultatImport } from "@/lib/server/contestationsStore";
import { jetonBoite } from "@/lib/server/mailSync";
import { chiffrer, dechiffrer, type Chiffre } from "@/lib/server/secretBox";
import { contester, lireMontant, lireProblemes, ouvrirUber, UberError, type ConfigUber, type DiagnosticUber, type SessionUber, type SuiviUber } from "@/lib/server/uberEatsBot";

/** restaurants/{rid}/private/ubereats : identifiants (mot de passe et session chiffrés), réglages et état du robot. */
export const refUber = (rid: RestaurantId) => adminDb().doc(`restaurants/${rid}/private/ubereats`);

export interface EtatRobot {
  le: number;
  ok: boolean;
  message: string;
  besoin?: string;
}

/**
 * settings/uberConnexion : la connexion du robot en direct, suivie par l'app pendant qu'elle se fait.
 * Le serveur y écrit { actif, interactif, debut, maj, etape, journal, capture, attenteCode, fin } ;
 * le gérant y écrit le code reçu d'Uber ({ code }), que le robot prend puis efface.
 */
const refConnexion = (rid: RestaurantId) => adminDb().doc(`restaurants/${rid}/settings/uberConnexion`);

/** Code tapé par le gérant, s'il y en a un : il est effacé dès qu'il est pris. */
async function prendreCode(rid: RestaurantId): Promise<string | null> {
  const ref = refConnexion(rid);
  const code = (await ref.get()).get("code");
  if (typeof code !== "string" || !/^\d{4,8}$/.test(code.trim())) return null;
  await ref.update({ code: FieldValue.delete() });
  return code.trim();
}

const DELAI_CODE = 150_000;

async function attendreCodeSaisi(rid: RestaurantId, canal: "sms" | "mail" | "inconnu"): Promise<string | null> {
  const ref = refConnexion(rid);
  const depuis = Date.now();
  await ref.set({ attenteCode: { canal, depuis, jusqua: depuis + DELAI_CODE } }, { merge: true });
  try {
    while (Date.now() - depuis < DELAI_CODE) {
      const code = await prendreCode(rid);
      if (code) return code;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return null;
  } finally {
    await ref.set({ attenteCode: null }, { merge: true }).catch(() => {});
  }
}

async function config(rid: RestaurantId, interactif = false): Promise<{ cfg: ConfigUber; modeAuto: boolean }> {
  const d = (await refUber(rid).get()).data();
  if (!d?.email) throw new UberError("Identifiants Uber Eats non renseignés : ajoute-les dans Réglages.", undefined, "identifiants");
  let motDePasse: string;
  try {
    motDePasse = d.motDePasse ? dechiffrer(d.motDePasse as Chiffre) : "";
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
      suivi: (m: SuiviUber) => refConnexion(rid).set({ ...m, maj: Date.now() }, { merge: true }).then(() => {}),
      ...(interactif ? { attendreCode: (canal: "sms" | "mail" | "inconnu") => attendreCodeSaisi(rid, canal), codeTape: () => prendreCode(rid) } : {}),
    },
    modeAuto: d.modeAuto === true,
  };
}

/** Ouvre Uber, fait le travail, garde la session. La connexion est suivie en direct dans l'app, du début au résultat. */
async function avecSession<T>(rid: RestaurantId, interactif: boolean, travail: (s: SessionUber, cfg: ConfigUber, modeAuto: boolean) => Promise<T>): Promise<T> {
  const { cfg, modeAuto } = await config(rid, interactif);
  const live = refConnexion(rid);
  const debut = Date.now();
  // Nouveau document : efface aussi un vieux code resté d'un passage précédent.
  await live.set({ actif: true, interactif, debut, maj: debut, etape: "Démarrage du navigateur", journal: [], attenteCode: null });
  let s: SessionUber | undefined;
  try {
    s = await ouvrirUber(cfg);
    const r = await travail(s, cfg, modeAuto);
    await live.set({ actif: false, maj: Date.now(), etape: "Terminé", fin: { ok: true, le: Date.now(), message: "Connexion réussie, travail terminé." } }, { merge: true });
    return r;
  } catch (e) {
    const d = e instanceof UberError ? e.diagnostic : undefined;
    await live
      .set(
        {
          actif: false,
          maj: Date.now(),
          attenteCode: null,
          fin: { ok: false, le: Date.now(), message: (e as Error).message, ...(d?.etape ? { etape: d.etape } : {}) },
          ...(d?.capture ? { capture: d.capture } : {}),
          ...(d?.journal ? { journal: d.journal } : {}),
        },
        { merge: true },
      )
      .catch(() => {});
    throw e;
  } finally {
    if (s) {
      const cookies = await s.fermer();
      if (cookies.length > 2) await refUber(rid).set({ session: chiffrer(cookies), sessionLe: Date.now() }, { merge: true });
    }
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
export async function releverUber(
  rid: RestaurantId,
  { budgetMs = 100_000, contesterAuto, interactif = false }: { budgetMs?: number; contesterAuto?: boolean; interactif?: boolean } = {},
): Promise<ResultatReleve> {
  const debut = Date.now();
  const reste = () => budgetMs - (Date.now() - debut);
  try {
    const r = await avecSession(rid, interactif, async (s, cfg, modeAuto) => {
      await s.noter("Lecture de la liste des problèmes");
      const { lignes, diagnostic } = await lireProblemes(s, cfg);
      const imp = await importerLignes(rid, lignes, "robot");
      await s.noter(`${lignes.length} commande(s) lue(s), ${imp.ajoutees} nouvelle(s)`);
      const out: ResultatReleve = { ...imp, lues: lignes.length, montantsLus: 0, contestees: [], echecs: [], diagnostic };

      const col = colContestations(rid);
      const fiches = (await col.where("issue", "==", "a_contester").get()).docs.map((d) => ({ id: d.id, ...(d.data() as Contestation) }));
      for (const f of fiches.filter((x) => x.montant === undefined)) {
        if (reste() < 25_000) break;
        await s.noter(`Lecture du montant de la commande ${f.commande}`);
        const m = await lireMontant(s, cfg, f.commande).catch(() => null);
        if (m) {
          await col.doc(f.id).update({ montant: m, updatedAt: Date.now() });
          out.montantsLus++;
        }
      }

      if (contesterAuto ?? modeAuto) {
        for (const f of fiches.filter((x) => aContester(x.etatUber))) {
          if (reste() < 30_000) break;
          await s.noter(`Contestation de la commande ${f.commande}`);
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
    const r = await avecSession(rid, true, async (s, cfg) => {
      await s.noter(`${essai ? "Essai (sans envoyer)" : "Contestation"} de la commande ${f.commande}`);
      return contester(s, cfg, f.commande, f.commentaire ?? "", essai);
    });
    if (!essai) {
      if (r.envoyee) {
        await col.doc(id).update({
          issue: "contestee",
          dateContestation: aujourdhui(),
          contesteePar: "robot",
          erreurRobot: FieldValue.delete(),
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
