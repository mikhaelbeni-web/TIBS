import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { chiffrer } from "@/lib/server/secretBox";
import { refUber } from "@/lib/server/uberService";

/**
 * Identifiants Uber Eats Manager d'un restaurant (restaurants/{rid}/private/ubereats, inaccessible au navigateur),
 * mot de passe chiffré AES-256-GCM, jamais renvoyé.
 * GET    ?r=19e : état (e-mail, boutique, adresse de la liste, mode automatique, dernier passage du robot).
 * POST   ?r=19e { email, motDePasse?, boutique?, urlProblemes?, modeAuto? }
 * DELETE ?r=19e : oublie identifiants et session.
 */
async function garde(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  return { uid, rid };
}

export async function GET(request: Request) {
  const g = await garde(request);
  if (g instanceof Response) return g;
  const d = (await refUber(g.rid).get()).data();
  return Response.json({
    configure: Boolean(d?.email && d?.motDePasse),
    email: d?.email ?? "",
    boutique: d?.boutique ?? "",
    urlProblemes: d?.urlProblemes ?? "",
    modeAuto: d?.modeAuto === true,
    majLe: d?.majLe ?? null,
    sessionLe: d?.sessionLe ?? null,
    dernierPassage: d?.dernierPassage ?? null,
  });
}

export async function POST(request: Request) {
  const g = await garde(request);
  if (g instanceof Response) return g;
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const email = str(b?.email, 200);
  const motDePasse = typeof b?.motDePasse === "string" ? b.motDePasse.slice(0, 200) : "";
  const urlProblemes = str(b?.urlProblemes, 600);
  if (!email) return Response.json({ error: "e-mail manquant" }, { status: 400 });
  if (urlProblemes && !/^https:\/\/([a-z0-9-]+\.)*ubereats\.com\//i.test(urlProblemes)) {
    return Response.json({ error: "L'adresse de la liste doit être une page de merchants.ubereats.com." }, { status: 400 });
  }
  const actuel = (await refUber(g.rid).get()).data();
  if (!motDePasse && !actuel?.motDePasse) return Response.json({ error: "mot de passe manquant" }, { status: 400 });
  const { FieldValue } = await import("firebase-admin/firestore");
  await refUber(g.rid).set(
    {
      email,
      boutique: str(b?.boutique, 120),
      urlProblemes,
      modeAuto: b?.modeAuto === true,
      ...(motDePasse ? { motDePasse: chiffrer(motDePasse) } : {}),
      // Changer de compte : on repart d'une session neuve.
      ...(actuel?.email && actuel.email !== email ? { session: FieldValue.delete(), sessionLe: FieldValue.delete() } : {}),
      majLe: Date.now(),
      majPar: g.uid,
    },
    { merge: true },
  );
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const g = await garde(request);
  if (g instanceof Response) return g;
  await adminDb().doc(refUber(g.rid).path).delete();
  return Response.json({ ok: true });
}
