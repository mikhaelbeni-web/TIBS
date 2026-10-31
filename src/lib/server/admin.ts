import "server-only";
import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Accès administrateur à Firestore, côté serveur uniquement (contourne les règles).
 * FIREBASE_SERVICE_ACCOUNT = contenu JSON de la clé de compte de service, encodé en base64.
 */
export function adminApp(): App {
  if (getApps().length) return getApps()[0]!;
  // Développement : émulateur Firestore, pas de clé nécessaire.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "demo-tibs" });
  }
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!b64) throw new Error("FIREBASE_SERVICE_ACCOUNT manquant");
  const json = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  return initializeApp({ credential: cert(json) });
}

export const adminDb = () => getFirestore(adminApp());
