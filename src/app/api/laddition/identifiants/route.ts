import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { chiffrer } from "@/lib/server/secretBox";

/**
 * Identifiants L'Addition d'un restaurant, stockés dans restaurants/{rid}/private/laddition
 * (inaccessible au navigateur), mot de passe chiffré AES-256-GCM. Le mot de passe n'est jamais renvoyé.
 *
 * GET    ?r=19e : état (identifiant, établissement, date d'enregistrement, dernier import).
 * POST   ?r=19e { identifiant, motDePasse?, etablissement? } : enregistre (mot de passe inchangé s'il est vide).
 * DELETE ?r=19e : oublie les identifiants.
 */
const ref = (rid: string) => adminDb().doc(`restaurants/${rid}/private/laddition`);

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
  const d = (await ref(g.rid).get()).data();
  return Response.json({
    configure: Boolean(d?.identifiant && d?.motDePasse),
    identifiant: d?.identifiant ?? "",
    etablissement: d?.etablissement ?? "",
    majLe: d?.majLe ?? null,
    dernierImport: d?.dernierImport ?? null,
  });
}

export async function POST(request: Request) {
  const g = await garde(request);
  if (g instanceof Response) return g;
  const body = (await request.json().catch(() => null)) as { identifiant?: unknown; motDePasse?: unknown; etablissement?: unknown } | null;
  const identifiant = typeof body?.identifiant === "string" ? body.identifiant.trim().slice(0, 200) : "";
  const motDePasse = typeof body?.motDePasse === "string" ? body.motDePasse.slice(0, 200) : "";
  const etablissement = typeof body?.etablissement === "string" ? body.etablissement.trim().slice(0, 120) : "";
  if (!identifiant) return Response.json({ error: "identifiant manquant" }, { status: 400 });
  const actuel = (await ref(g.rid).get()).data();
  if (!motDePasse && !actuel?.motDePasse) return Response.json({ error: "mot de passe manquant" }, { status: 400 });
  await ref(g.rid).set(
    {
      identifiant,
      etablissement,
      ...(motDePasse ? { motDePasse: chiffrer(motDePasse) } : {}),
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
  await ref(g.rid).delete();
  return Response.json({ ok: true });
}
