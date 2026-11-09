import { normNumero, type Releve } from "@/lib/releves";
import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { chercherDansBoites, enregistrerVerif } from "@/lib/server/relevesPasse";

/**
 * POST /api/releves/verifier?r=19e (gérant) { releveId, numeros } : avant de préparer la réclamation,
 * cherche ces factures du relevé dans les deux boîtes Gmail. Lecture seule côté Gmail.
 * Réponse : { trouvees: { numéroNormalisé: { boite, messageId, date, objet } }, cherchees }.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const releveId = typeof b?.releveId === "string" ? b.releveId : "";
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(releveId)) return Response.json({ error: "Relevé inconnu." }, { status: 400 });
  const ref = adminDb().doc(`restaurants/${rid}/releves/${releveId}`);
  const snap = await ref.get();
  if (!snap.exists) return Response.json({ error: "Relevé introuvable." }, { status: 404 });
  const x = snap.data() as Releve;
  // Seulement des numéros qui figurent sur le relevé.
  const demandes = new Set((Array.isArray(b?.numeros) ? b.numeros : []).filter((n): n is string => typeof n === "string").map(normNumero));
  const numeros = x.lignes.map((l) => l.numero).filter((n) => demandes.has(normNumero(n)));
  try {
    const res = await chercherDansBoites(numeros, x);
    await enregistrerVerif(ref, x, res);
    return Response.json(res);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
