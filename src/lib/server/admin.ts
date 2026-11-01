import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Accès administrateur à Firestore, côté serveur uniquement (contourne les règles).
 * FIREBASE_SERVICE_ACCOUNT = contenu du fichier JSON de la clé de compte de service,
 * collé tel quel dans Vercel (ou encodé en base64).
 */
export function adminApp(): App {
  if (getApps().length) return getApps()[0]!;
  // Développement : émulateur Firestore, pas de clé nécessaire.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "demo-tibs" });
  }
  return initializeApp({ credential: cert(serviceAccount() as Parameters<typeof cert>[0]) });
}

/** Lit FIREBASE_SERVICE_ACCOUNT (JSON brut ou base64) avec des erreurs compréhensibles. */
export function serviceAccount(): { project_id?: string; client_email?: string; private_key?: string } {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT?.trim();
  if (!raw) throw new Error("FIREBASE_SERVICE_ACCOUNT est absent dans Vercel (ou le site n'a pas été redéployé).");
  let json: { project_id?: string; client_email?: string; private_key?: string };
  try {
    json = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT est illisible : colle tout le contenu du fichier .json, de la première { à la dernière }.");
  }
  if (!json.private_key || !json.client_email) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT ne ressemble pas à une clé de compte de service (private_key ou client_email manquant).");
  }
  return json;
}

export const adminDb = () => getFirestore(adminApp());
