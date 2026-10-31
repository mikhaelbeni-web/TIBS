import { FieldValue } from "firebase-admin/firestore";
import { adminDb } from "@/lib/server/admin";
import { appOrigin, exchangeCode, GMAIL_SCOPE, gmailProfile, verifyState } from "@/lib/server/google";

/** GET /api/gmail/callback : retour de Google après consentement. Enregistre le refresh token côté serveur. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const back = (q: string) => Response.redirect(`${appOrigin(request)}/a-verifier?gmail=${q}`, 303);
  if (url.searchParams.get("error")) return back("refuse");
  const code = url.searchParams.get("code");
  const uid = verifyState(url.searchParams.get("state") ?? "");
  if (!code || !uid) return back("lien_expire");

  try {
    const t = await exchangeCode(request, code);
    if (!t.scope.includes(GMAIL_SCOPE)) return back("droits_manquants");
    if (!t.refreshToken) return back("pas_de_jeton");
    const { emailAddress } = await gmailProfile(t.accessToken);
    const db = adminDb();
    await db.doc("private/gmail").set({ refreshToken: t.refreshToken, adresse: emailAddress, connectePar: uid, connecteLe: Date.now() });
    await db.doc("settings/mail").set({ adresse: emailAddress, connecteLe: Date.now(), erreur: FieldValue.delete() }, { merge: true });
    return back("ok");
  } catch (e) {
    console.error("gmail callback:", (e as Error).message);
    return back("erreur");
  }
}
