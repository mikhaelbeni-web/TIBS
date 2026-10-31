import { DEFAULT_RESTAURANT, isRestaurantId } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { inboxDocId, parseInboxItem, safeEqual, type InboxDoc } from "@/lib/ingest";

/**
 * POST /api/ingest?r=19e — réservé à la tâche quotidienne qui lit les mails.
 * En-tête : Authorization: Bearer <INGEST_TOKEN>
 * Corps : { "items": [ { "kind": "facture" | "uber", ..., "source": { "messageId": "..." } } ] }
 * Réponse : { created, skipped, errors: [{ index, error }] }
 */
export async function POST(request: Request) {
  const token = process.env.INGEST_TOKEN;
  const auth = request.headers.get("authorization") ?? "";
  if (!token || token.length < 32 || !safeEqual(auth, `Bearer ${token}`)) {
    return Response.json({ error: "non autorisé" }, { status: 401 });
  }

  const rid = new URL(request.url).searchParams.get("r") ?? DEFAULT_RESTAURANT;
  if (!isRestaurantId(rid)) return Response.json({ error: "restaurant inconnu" }, { status: 400 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "JSON invalide" }, { status: 400 });
  }
  const raw = (body as { items?: unknown })?.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 200) {
    return Response.json({ error: "items doit être une liste de 1 à 200 éléments" }, { status: 400 });
  }

  const db = adminDb();
  const errors: { index: number; error: string }[] = [];
  let created = 0;
  let skipped = 0;
  const perMessage = new Map<string, number>();

  for (const [index, r] of raw.entries()) {
    const item = parseInboxItem(r);
    if (typeof item === "string") {
      errors.push({ index, error: item });
      continue;
    }
    const n = perMessage.get(item.source.messageId) ?? 0;
    perMessage.set(item.source.messageId, n + 1);
    const ref = db.collection(`restaurants/${rid}/inbox`).doc(inboxDocId(item.source.messageId, n));
    const data: InboxDoc = { item, statut: "a_verifier", receivedAt: Date.now() };
    try {
      await ref.create(data); // échoue si déjà reçu : la tâche peut repasser sur le même mail sans doublon
      created++;
    } catch (e) {
      if ((e as { code?: number }).code === 6) skipped++;
      else errors.push({ index, error: "écriture impossible" });
    }
  }
  return Response.json({ created, skipped, errors }, { status: errors.length && !created ? 400 : 200 });
}
