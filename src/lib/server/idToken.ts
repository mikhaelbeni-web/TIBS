import "server-only";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";

/**
 * Vérifie un jeton d'identité Firebase (Authorization: Bearer …) sans firebase-admin/auth,
 * dont une dépendance (jwks-rsa → jose) ne se charge pas sur Vercel.
 * Règles officielles : RS256, signé par les clés securetoken de Google, aud = projet, iss = securetoken/projet.
 */
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyFirebaseIdToken(token: string, projectId: string): Promise<string> {
  // Émulateur Auth (développement) : jetons non signés.
  if (process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    const p = decodeJwt(token);
    if (p.aud !== projectId || !p.sub) throw new Error("jeton émulateur invalide");
    return p.sub;
  }
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(token, jwks, {
    algorithms: ["RS256"],
    audience: projectId,
    issuer: `https://securetoken.google.com/${projectId}`,
  });
  if (!payload.sub) throw new Error("jeton sans utilisateur");
  if (typeof payload.auth_time === "number" && payload.auth_time > Date.now() / 1000 + 300) throw new Error("auth_time dans le futur");
  return payload.sub;
}
