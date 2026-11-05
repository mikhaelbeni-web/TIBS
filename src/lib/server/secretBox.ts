import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { serviceAccount } from "@/lib/server/admin";

/**
 * Chiffrement AES-256-GCM des secrets stockés en base (mot de passe L'Addition).
 * Clé : SECRETS_KEY (Vercel) si présente, sinon dérivée de la clé privée du compte de service Firebase,
 * qui ne quitte jamais le serveur. Changer l'une ou l'autre oblige à ressaisir le mot de passe.
 */
export interface Chiffre {
  iv: string;
  tag: string;
  data: string;
}

function cle(secret?: string): Buffer {
  const base = secret ?? process.env.SECRETS_KEY ?? serviceAccount().private_key;
  if (!base) throw new Error("Aucune clé de chiffrement disponible sur le serveur.");
  return Buffer.from(hkdfSync("sha256", base, "tibs", "tibs/secrets/v1", 32));
}

export function chiffrer(texte: string, secret?: string): Chiffre {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", cle(secret), iv);
  const data = Buffer.concat([c.update(texte, "utf8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

export function dechiffrer(box: Chiffre, secret?: string): string {
  const d = createDecipheriv("aes-256-gcm", cle(secret), Buffer.from(box.iv, "base64"));
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf8");
}
