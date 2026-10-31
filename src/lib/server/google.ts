import "server-only";
import { createHmac } from "node:crypto";
import { safeEqual } from "@/lib/ingest";
import type { GmailMessage } from "@/lib/mail";

/**
 * Connexion OAuth Google et appels à l'API Gmail, en lecture seule.
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET : identifiants OAuth « Application Web » (console Google Cloud).
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function creds() {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET doivent être renseignés dans Vercel.");
  return { id, secret };
}

/** Adresse publique de l'app (pour l'URL de retour Google). APP_URL prioritaire, sinon l'origine de la requête. */
export function appOrigin(request: Request): string {
  return (process.env.APP_URL || new URL(request.url).origin).replace(/\/$/, "");
}

export const redirectUri = (request: Request) => `${appOrigin(request)}/api/gmail/callback`;

/** « state » OAuth signé : identifie le gérant qui lance la connexion, valable 10 minutes. */
export function signState(uid: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: now + 10 * 60_000 })).toString("base64url");
  const sig = createHmac("sha256", creds().secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(state: string, now = Date.now()): string | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  const expected = createHmac("sha256", creds().secret).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try {
    const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof uid === "string" && typeof exp === "number" && exp > now ? uid : null;
  } catch {
    return null;
  }
}

export function authUrl(request: Request, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", creds().id);
  u.searchParams.set("redirect_uri", redirectUri(request));
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", GMAIL_SCOPE);
  u.searchParams.set("access_type", "offline"); // pour obtenir un refresh token
  u.searchParams.set("prompt", "consent");
  u.searchParams.set("include_granted_scopes", "true");
  u.searchParams.set("state", state);
  if (process.env.MAIL_ADDRESS) u.searchParams.set("login_hint", process.env.MAIL_ADDRESS);
  return u.toString();
}

export class GoogleAuthError extends Error {}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: creds().id, client_secret: creds().secret, ...body }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (!res.ok) {
    if (json.error === "invalid_grant") throw new GoogleAuthError("Accès Gmail révoqué ou expiré : reconnecte la boîte.");
    throw new Error(`Google a refusé la demande (${json.error ?? res.status}).`);
  }
  return json;
}

export async function exchangeCode(request: Request, code: string) {
  const t = await tokenRequest({ code, grant_type: "authorization_code", redirect_uri: redirectUri(request) });
  return { accessToken: t.access_token, refreshToken: t.refresh_token as string | undefined, scope: t.scope ?? "" };
}

export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const t = await tokenRequest({ refresh_token: refreshToken, grant_type: "refresh_token" });
  return t.access_token;
}

export async function revoke(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST" }).catch(() => {});
}

async function gmail<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) throw new GoogleAuthError("Accès Gmail refusé : reconnecte la boîte.");
  if (!res.ok) throw new Error(`Gmail ${res.status} sur ${path.split("?")[0]}`);
  return (await res.json()) as T;
}

export const gmailProfile = (token: string) => gmail<{ emailAddress: string }>(token, "profile");

/** Identifiants des messages qui correspondent à la requête (au plus `max`). */
export async function listMessageIds(token: string, q: string, max = 500): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, maxResults: "100", ...(pageToken ? { pageToken } : {}) });
    const page = await gmail<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `messages?${params}`);
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

export const getMessage = (token: string, id: string) => gmail<GmailMessage>(token, `messages/${id}?format=full`);

/** Contenu d'une pièce jointe, en base64 standard (prêt pour l'API Claude). */
export async function getAttachment(token: string, messageId: string, attachmentId: string): Promise<string> {
  const a = await gmail<{ data: string }>(token, `messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(a.data, "base64url").toString("base64");
}
