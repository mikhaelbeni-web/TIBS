import "server-only";
import { createHmac, createPrivateKey, type KeyObject } from "node:crypto";
import { SignJWT } from "jose";
import { appelLectureSeule, normaliserPem, type EbTransaction } from "@/lib/banque";
import { safeEqual } from "@/lib/ingest";
import { isRestaurantId, type RestaurantId } from "@/lib/restaurants";

/**
 * Accès bancaire DSP2 en lecture seule via Enable Banking (https://enablebanking.com).
 * ENABLEBANKING_APP_ID : identifiant de l'application (Control Panel Enable Banking).
 * ENABLEBANKING_PRIVATE_KEY : contenu du fichier .pem de la clé privée (collé tel quel, ou en base64).
 * Aucun identifiant bancaire ne transite par l'app : la connexion se fait sur le site de la banque.
 */
const API = "https://api.enablebanking.com";

export class BanqueNonConfiguree extends Error {}
export class AccesExpire extends Error {}

export function configuree(): boolean {
  return Boolean(process.env.ENABLEBANKING_APP_ID && process.env.ENABLEBANKING_PRIVATE_KEY);
}

let cle: { id: string; key: KeyObject } | null = null;
function app(): { id: string; key: KeyObject } {
  const id = process.env.ENABLEBANKING_APP_ID?.trim();
  const brut = process.env.ENABLEBANKING_PRIVATE_KEY?.trim();
  if (!id || !brut) throw new BanqueNonConfiguree("ENABLEBANKING_APP_ID et ENABLEBANKING_PRIVATE_KEY doivent être renseignés dans Vercel.");
  if (cle?.id === id) return cle;
  const n = normaliserPem(brut);
  if ("erreur" in n) throw new BanqueNonConfiguree(`ENABLEBANKING_PRIVATE_KEY : ${n.erreur}`);
  try {
    cle = { id, key: createPrivateKey(n.pem) };
  } catch (e) {
    throw new BanqueNonConfiguree(`ENABLEBANKING_PRIVATE_KEY illisible (${(e as Error).message.slice(0, 80)}) : recolle tout le fichier .pem.`);
  }
  return cle;
}

async function jeton(): Promise<string> {
  const { id, key } = app();
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: id })
    .setIssuer("enablebanking.com")
    .setAudience("api.enablebanking.com")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

async function appel<T>(chemin: string, init: RequestInit = {}): Promise<T> {
  // Verrou lecture seule : aucun appel de paiement ou de virement ne peut partir d'ici.
  if (!appelLectureSeule(init.method ?? "GET", chemin)) throw new Error(`Appel bancaire refusé (lecture seule) : ${init.method ?? "GET"} ${chemin.split("?")[0]}`);
  const res = await fetch(`${API}${chemin}`, {
    redirect: "error",
    ...init,
    headers: { authorization: `Bearer ${await jeton()}`, "content-type": "application/json", accept: "application/json", ...init.headers },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg = String(json.message ?? json.error ?? json.detail ?? res.status);
    if (res.status === 401 || res.status === 403 || /expired|invalid session|revoked|EXPIRED_SESSION|closed/i.test(msg)) {
      if (chemin.startsWith("/accounts") || chemin.startsWith("/sessions/")) throw new AccesExpire("Accès bancaire expiré ou révoqué : reconnecte la banque.");
    }
    throw new Error(`Banque (Enable Banking) : ${msg}`);
  }
  return json as T;
}

export interface Aspsp {
  name: string;
  country: string;
  psu_types?: string[];
  maximum_consent_validity?: number;
  logo?: string;
}

export async function banques(): Promise<Aspsp[]> {
  const r = await appel<{ aspsps: Aspsp[] }>("/aspsps?country=FR&service=AIS");
  return r.aspsps ?? [];
}

export async function demarrer(o: { banque: string; psuType: "business" | "personal"; redirect: string; state: string; validUntil: string }) {
  return appel<{ url: string; authorization_id: string }>("/auth", {
    method: "POST",
    body: JSON.stringify({
      access: { valid_until: o.validUntil },
      aspsp: { name: o.banque, country: "FR" },
      state: o.state,
      redirect_url: o.redirect,
      psu_type: o.psuType,
      language: "fr",
    }),
  });
}

export interface EbCompte {
  uid: string;
  name?: string | null;
  product?: string | null;
  currency?: string | null;
  account_id?: { iban?: string | null } | null;
}

export async function ouvrirSession(code: string) {
  return appel<{ session_id: string; accounts: EbCompte[]; aspsp: { name: string }; access: { valid_until: string } }>("/sessions", {
    method: "POST",
    body: JSON.stringify({ code }),
  });
}

export async function fermerSession(id: string): Promise<void> {
  await appel(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
}

/** Toutes les opérations d'un compte depuis dateFrom (pages successives). */
export async function operations(uid: string, dateFrom: string, maxPages = 30): Promise<EbTransaction[]> {
  const out: EbTransaction[] = [];
  let suite: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const q = new URLSearchParams({ date_from: dateFrom });
    if (suite) q.set("continuation_key", suite);
    const r = await appel<{ transactions?: EbTransaction[]; continuation_key?: string | null }>(`/accounts/${encodeURIComponent(uid)}/transactions?${q}`);
    out.push(...(r.transactions ?? []));
    suite = r.continuation_key ?? undefined;
    if (!suite) break;
  }
  return out;
}

/** IBAN masqué pour l'affichage : FR76 •••• 1234. */
export function ibanMasque(iban?: string | null): string {
  if (!iban) return "";
  const s = iban.replace(/\s+/g, "");
  return `${s.slice(0, 4)} •••• ${s.slice(-4)}`;
}

// « state » signé : identifie le gérant et le restaurant au retour de la banque (valable 30 minutes).
function cleState(): string {
  const { id, key } = app();
  return createHmac("sha256", key.export({ format: "pem", type: "pkcs8" }).toString()).update(`state:${id}`).digest("hex");
}

export function signerState(uid: string, rid: RestaurantId, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ uid, rid, exp: now + 30 * 60_000 })).toString("base64url");
  return `${payload}.${createHmac("sha256", cleState()).update(payload).digest("base64url")}`;
}

export function lireState(state: string, now = Date.now()): { uid: string; rid: RestaurantId } | null {
  const [payload, sig] = state.split(".");
  if (!payload || !sig) return null;
  if (!safeEqual(sig, createHmac("sha256", cleState()).update(payload).digest("base64url"))) return null;
  try {
    const { uid, rid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof uid === "string" && isRestaurantId(rid) && typeof exp === "number" && exp > now ? { uid, rid } : null;
  } catch {
    return null;
  }
}
