import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/admin";
import { syncBanque, type BanquePrivee } from "@/lib/server/banqueSync";
import { fermerSession, ibanMasque, lireState, ouvrirSession } from "@/lib/server/enableBanking";
import { appOrigin } from "@/lib/server/google";

export const maxDuration = 120;

/** GET /api/banque/callback : retour de la banque après validation. Ouvre la session et lance un premier relevé. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (q: string, rid?: string) => Response.redirect(`${appOrigin(request)}/rapprochement?banque=${q}${rid ? `&r=${rid}` : ""}`, 303);
  let state: ReturnType<typeof lireState>;
  try {
    state = lireState(url.searchParams.get("state") ?? "");
  } catch {
    return back("erreur");
  }
  if (!state) return back("lien_expire");
  if (url.searchParams.get("error")) return back("refuse", state.rid);
  const code = url.searchParams.get("code");
  if (!code) return back("refuse", state.rid);

  try {
    const s = await ouvrirSession(code);
    const comptes = (s.accounts ?? []).map((a) => ({
      uid: a.uid,
      nom: a.name || a.product || "Compte",
      iban: ibanMasque(a.account_id?.iban),
    }));
    if (!comptes.length) return back("aucun_compte", state.rid);
    const home = adminDb().doc(`restaurants/${state.rid}`);
    const ancien = (await home.collection("private").doc("banque").get()).data() as BanquePrivee | undefined;
    const priv: BanquePrivee = {
      sessionId: s.session_id,
      banque: s.aspsp?.name ?? "",
      comptes,
      validUntil: s.access?.valid_until ?? "",
      connectePar: state.uid,
      connecteLe: Date.now(),
    };
    await home.collection("private").doc("banque").set(priv);
    await home.collection("settings").doc("banque").set(
      {
        banque: priv.banque,
        comptes,
        validUntil: priv.validUntil,
        connecteLe: priv.connecteLe,
        erreur: FieldValue.delete(),
        expiree: FieldValue.delete(),
      },
      { merge: true },
    );
    if (ancien?.sessionId && ancien.sessionId !== s.session_id) await fermerSession(ancien.sessionId);
    await syncBanque(state.rid);
    return back("ok", state.rid);
  } catch (e) {
    console.error("banque callback:", (e as Error).message);
    return back("erreur", state.rid);
  }
}
