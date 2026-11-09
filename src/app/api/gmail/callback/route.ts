import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/admin";
import { appOrigin, exchangeCode, GMAIL_SCOPE, GMAIL_SEND_SCOPE, gmailProfile, verifyState } from "@/lib/server/google";

/** GET /api/gmail/callback : retour de Google après consentement. Enregistre le refresh token côté serveur. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = verifyState(url.searchParams.get("state") ?? "");
  const back = (q: string, rid?: string) => {
    const page = state?.retour ?? "/a-verifier";
    return Response.redirect(`${appOrigin(request)}${page}${page.includes("?") ? "&" : "?"}gmail=${q}${rid ? `&r=${rid}` : ""}`, 303);
  };
  if (url.searchParams.get("error")) return back("refuse", state?.rid);
  const code = url.searchParams.get("code");
  if (!code || !state) return back("lien_expire");

  try {
    const t = await exchangeCode(request, code);
    if (!t.scope.includes(GMAIL_SCOPE)) return back("droits_manquants", state.rid);
    if (state.envoi && !t.scope.includes(GMAIL_SEND_SCOPE)) return back("envoi_refuse", state.rid);
    if (!t.refreshToken) return back("pas_de_jeton", state.rid);
    const { emailAddress } = await gmailProfile(t.accessToken);
    const home = adminDb().doc(`restaurants/${state.rid}`);
    // include_granted_scopes : le jeton garde le droit d'envoi s'il avait déjà été donné.
    const envoi = t.scope.includes(GMAIL_SEND_SCOPE);
    await home.collection("private").doc("gmail").set({ refreshToken: t.refreshToken, adresse: emailAddress, connectePar: state.uid, connecteLe: Date.now(), envoi });
    await home
      .collection("settings")
      .doc("mail")
      .set({ adresse: emailAddress, connecteLe: Date.now(), erreur: FieldValue.delete(), envoi }, { merge: true });
    return back("ok", state.rid);
  } catch (e) {
    console.error("gmail callback:", (e as Error).message);
    return back("erreur", state.rid);
  }
}
