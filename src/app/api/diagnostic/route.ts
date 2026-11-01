import { adminDb, serviceAccount } from "@/lib/server/admin";

import { connection } from "next/server";

/**
 * GET /api/diagnostic : dit quelles variables Vercel sont en place, sans jamais afficher leur valeur.
 * Sert à dépanner la connexion Gmail.
 */
export async function GET() {
  await connection();
  const present = (k: string) => {
    const v = process.env[k]?.trim();
    return !v ? "absente" : v.startsWith("A_REMPLIR") ? "à remplir" : "ok";
  };
  const out: Record<string, string> = {
    GOOGLE_CLIENT_ID: present("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: present("GOOGLE_CLIENT_SECRET"),
    CRON_SECRET: present("CRON_SECRET"),
    FIREBASE_SERVICE_ACCOUNT: "ok",
    base_de_donnees: "non testée",
  };
  try {
    const sa = serviceAccount();
    const attendu = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
    if (attendu && sa.project_id !== attendu) out.FIREBASE_SERVICE_ACCOUNT = `clé d'un autre projet (${sa.project_id}), il faut celle de ${attendu}`;
  } catch (e) {
    out.FIREBASE_SERVICE_ACCOUNT = (e as Error).message;
  }
  if (out.FIREBASE_SERVICE_ACCOUNT === "ok") {
    try {
      await adminDb().doc("restaurants/19e/settings/mail").get();
      out.base_de_donnees = "ok";
    } catch (e) {
      out.base_de_donnees = `erreur : ${(e as Error).message}`;
    }
  }
  const toutOk = Object.values(out).every((v) => v === "ok");
  return Response.json({ toutOk, ...out }, { headers: { "cache-control": "no-store" } });
}
