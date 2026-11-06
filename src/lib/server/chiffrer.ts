import "server-only";
import { constants, createCipheriv, createPublicKey, publicEncrypt, randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * Chiffre un résultat pour qu'il puisse traverser un journal public (GitHub Actions) :
 * seule la personne qui détient la clé privée correspondant à `cleB64` peut le lire.
 * cleB64 = clé publique RSA (SPKI, DER) en base64. Clé AES-256-GCM aléatoire, enveloppée en RSA-OAEP-SHA256.
 * Données : JSON compressé en gzip. Sortie : base64( longueur clé enveloppée (2 octets) | clé enveloppée | iv (12) | tag (16) | données ).
 */
export function chiffrerPour(cleB64: string, donnees: unknown): string {
  const pub = createPublicKey({ key: Buffer.from(cleB64, "base64"), format: "der", type: "spki" });
  if (pub.asymmetricKeyType !== "rsa" || (pub.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("clé publique RSA 2048 bits minimum attendue");
  const k = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  const corps = Buffer.concat([c.update(gzipSync(JSON.stringify(donnees))), c.final()]);
  const env = publicEncrypt({ key: pub, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
  const lg = Buffer.alloc(2);
  lg.writeUInt16BE(env.length);
  return Buffer.concat([lg, env, iv, c.getAuthTag(), corps]).toString("base64");
}
