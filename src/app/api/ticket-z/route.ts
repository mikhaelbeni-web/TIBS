import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { extractionEnabled } from "@/lib/server/extract";
import { enregistrerConsommation, lecteurPour } from "@/lib/server/mailSync";
import { lireEtEnregistrerZ, telechargerZ, ZErreur } from "@/lib/server/ticketZServeur";

export const maxDuration = 60;

const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

/**
 * POST /api/ticket-z?r=19e (gérant) { base64, mediaType, jour? } ou { url, jour? }
 * Lit un ticket Z de L'Addition avec Claude et l'enregistre sur la journée de service
 * (Z du 05/11 clôturé à 00:53 → journée du 04/11) dans cashEntries/{jour}.
 * { url } : lien signé data.laddition.com de l'export « Détails par service », téléchargé tout de suite.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  if (!extractionEnabled()) return Response.json({ error: "Lecture IA non configurée (clé ANTHROPIC_API_KEY absente)." }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { base64?: unknown; mediaType?: unknown; jour?: unknown; url?: unknown } | null;
  try {
    if (body && body.url !== undefined) {
      body.base64 = await telechargerZ(body.url);
      body.mediaType = "application/pdf";
    }
    if (!body || typeof body.base64 !== "string" || typeof body.mediaType !== "string" || !TYPES.includes(body.mediaType)) {
      return Response.json({ error: "Fichier attendu : PDF, JPEG, PNG ou WebP." }, { status: 400 });
    }
    if (body.base64.length > 6_000_000) return Response.json({ error: "Fichier trop lourd (4 Mo max)." }, { status: 413 });

    const statusRef = adminDb().doc(`restaurants/${rid}/settings/mail`);
    const lecteur = lecteurPour((await statusRef.get()).data() ?? {});
    try {
      const { jour, entry } = await lireEtEnregistrerZ(rid, { base64: body.base64, mediaType: body.mediaType }, lecteur);
      const attendu = typeof body.jour === "string" ? body.jour : undefined;
      return Response.json({ ok: true, jour, entry, ...(attendu && attendu !== jour ? { avertissement: `Ce Z correspond au ${jour}, pas au ${attendu}.` } : {}) });
    } finally {
      await enregistrerConsommation(statusRef, lecteur).catch(() => {});
    }
  } catch (e) {
    if (e instanceof ZErreur) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
