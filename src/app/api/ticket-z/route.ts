import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { extractionEnabled, extractTicketZ } from "@/lib/server/extract";
import { enregistrerConsommation, lecteurPour } from "@/lib/server/mailSync";
import { categorie, jourDuTicket, totaux, urlZAutorisee } from "@/lib/ticketZ";

export const maxDuration = 60;

const TYPES = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

/** Télécharge le PDF du Z tout de suite (le lien est signé et peut expirer ; il n'est ni stocké ni journalisé). */
async function telechargerZ(url: URL): Promise<string | Response> {
  let res: globalThis.Response;
  try {
    res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch {
    return Response.json({ error: "Téléchargement du ticket Z impossible (lien expiré ou L'Addition injoignable)." }, { status: 502 });
  }
  if (!res.ok) return Response.json({ error: `L'Addition a répondu ${res.status} pour le ticket Z (lien peut-être expiré : réexporte le fichier).` }, { status: 502 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4_000_000) return Response.json({ error: "Ticket Z trop lourd." }, { status: 413 });
  if (buf.subarray(0, 5).toString("latin1") !== "%PDF-") return Response.json({ error: "Le lien L'Addition n'a pas renvoyé de PDF." }, { status: 502 });
  return buf.toString("base64");
}

/**
 * POST /api/ticket-z?r=19e (gérant) { base64, mediaType, jour? }
 * Lit un ticket Z de L'Addition avec Claude et l'enregistre sur la journée de service
 * (Z du 05/11 clôturé à 00:53 → journée du 04/11) dans cashEntries/{jour}.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  if (!extractionEnabled()) return Response.json({ error: "Lecture IA non configurée (clé ANTHROPIC_API_KEY absente)." }, { status: 503 });

  const body = (await request.json().catch(() => null)) as { base64?: unknown; mediaType?: unknown; jour?: unknown; url?: unknown } | null;
  if (body && body.url !== undefined) {
    const url = urlZAutorisee(body.url);
    if (!url) return Response.json({ error: "Lien de ticket Z non reconnu (data.laddition.com attendu)." }, { status: 400 });
    const pdf = await telechargerZ(url);
    if (pdf instanceof Response) return pdf;
    body.base64 = pdf;
    body.mediaType = "application/pdf";
  }
  if (!body || typeof body.base64 !== "string" || typeof body.mediaType !== "string" || !TYPES.includes(body.mediaType)) {
    return Response.json({ error: "Fichier attendu : PDF, JPEG, PNG ou WebP." }, { status: 400 });
  }
  if (body.base64.length > 6_000_000) return Response.json({ error: "Fichier trop lourd (4 Mo max)." }, { status: 413 });

  const db = adminDb();
  const statusRef = db.doc(`restaurants/${rid}/settings/mail`);
  const lecteur = lecteurPour((await statusRef.get()).data() ?? {});
  if (!lecteur.peutLire()) {
    const raison = lecteur.raison === "budget" ? "budget IA du mois atteint (Réglages)" : "lecture IA désactivée dans les Réglages";
    return Response.json({ error: `Lecture impossible : ${raison}.` }, { status: 429 });
  }

  let z;
  try {
    z = await extractTicketZ({ base64: body.base64, mediaType: body.mediaType }, lecteur);
  } catch (e) {
    console.error("ticket-z", e);
    return Response.json({ error: `Lecture IA en échec : ${(e as Error).message}` }, { status: 502 });
  } finally {
    await enregistrerConsommation(statusRef, lecteur).catch(() => {});
  }
  if (!z) return Response.json({ error: "Ce document ne ressemble pas à un ticket Z." }, { status: 422 });
  if (!z.dateTicket) return Response.json({ error: "Date du ticket illisible." }, { status: 422 });

  const jour = jourDuTicket(z.dateTicket, z.heureCloture);
  const paiements = z.paiements.map((p) => ({ ...p, categorie: categorie(p.libelle) }));
  const t = totaux(paiements);
  const entry = {
    date: jour,
    cb: t.cb,
    especes: t.especes,
    ticketsResto: t.ticketsResto,
    autres: t.autres,
    uber: t.uber,
    ...(paiements.some((p) => p.categorie === "uber" && p.nombre !== undefined) ? { uberCommandes: t.uberCommandes } : {}),
    ...(z.total !== undefined ? { total: z.total } : {}),
    ...(z.ttc55 !== undefined ? { ttc55: z.ttc55 } : {}),
    ...(z.ttc10 !== undefined ? { ttc10: z.ttc10 } : {}),
    ...(z.ttc20 !== undefined ? { ttc20: z.ttc20 } : {}),
    paiements,
    source: "ticketZ",
    ticketZ: { dateTicket: z.dateTicket, ...(z.heureCloture ? { heureCloture: z.heureCloture } : {}), luLe: Date.now() },
    createdAt: Date.now(),
  };
  // Fusion : garde les chiffres de l'export « Détails par service » (CA TTC net…) s'ils existent.
  await db.doc(`restaurants/${rid}/cashEntries/${jour}`).set(entry, { merge: true });
  const attendu = typeof body.jour === "string" ? body.jour : undefined;
  return Response.json({ ok: true, jour, entry, ...(attendu && attendu !== jour ? { avertissement: `Ce Z correspond au ${jour}, pas au ${attendu}.` } : {}) });
}
