import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyFirebaseIdToken } from "../idToken";

const PID = "tiibs-2ac00";
let priv: CryptoKey;
let autre: CryptoKey;

beforeAll(async () => {
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const kp = await generateKeyPair("RS256");
  priv = kp.privateKey;
  autre = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ keys: [jwk] }), { headers: { "content-type": "application/json" } }));
});
afterAll(() => vi.unstubAllGlobals());

const jeton = (key: CryptoKey, claims: { aud?: string; iss?: string; sub?: string } = {}) =>
  new SignJWT({ auth_time: Math.floor(Date.now() / 1000) - 10 })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setAudience(claims.aud ?? PID)
    .setIssuer(claims.iss ?? `https://securetoken.google.com/${PID}`)
    .setSubject(claims.sub ?? "uid123")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);

describe("verifyFirebaseIdToken", () => {
  it("accepte un jeton valide et renvoie l'uid", async () => {
    expect(await verifyFirebaseIdToken(await jeton(priv), PID)).toBe("uid123");
  });
  it("refuse un autre projet, un autre émetteur ou une mauvaise signature", async () => {
    await expect(verifyFirebaseIdToken(await jeton(priv, { aud: "autre" }), PID)).rejects.toThrow();
    await expect(verifyFirebaseIdToken(await jeton(priv, { iss: "https://evil" }), PID)).rejects.toThrow();
    await expect(verifyFirebaseIdToken(await jeton(autre), PID)).rejects.toThrow();
  });
});
