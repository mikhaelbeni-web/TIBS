import { mergeRules } from "@/lib/mail";
import { parseReglages } from "@/lib/reglages";
import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";

/**
 * POST /api/reglages?r=19e (gérant) { reglages?, regles? } : enregistre les réglages du restaurant.
 * Écrit par le serveur (settings/mail est en lecture seule côté navigateur), après validation.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const body = (await request.json().catch(() => null)) as { reglages?: unknown; regles?: unknown } | null;
  if (!body || typeof body !== "object") return Response.json({ error: "requête invalide" }, { status: 400 });

  const update: Record<string, unknown> = { reglagesModifies: Date.now(), reglagesPar: uid };
  if (body.reglages !== undefined) update.reglages = parseReglages(body.reglages);
  if (body.regles !== undefined) {
    const r = mergeRules(body.regles as never);
    const cap = (l: string[]) => l.slice(0, 200).map((x) => x.slice(0, 120));
    update.regles = {
      uberExpediteurs: cap(r.uberExpediteurs),
      uberMotsCles: cap(r.uberMotsCles),
      factureMotsCles: cap(r.factureMotsCles),
      factureExclure: cap(r.factureExclure),
      ignorer: cap(r.ignorer),
      fournisseurs: Object.fromEntries(Object.entries(r.fournisseurs).slice(0, 300).map(([k, v]) => [k.slice(0, 120), v.slice(0, 120)])),
    };
  }
  await adminDb().doc(`restaurants/${rid}/settings/mail`).set(update, { merge: true });
  return Response.json({ ok: true, ...update });
}
