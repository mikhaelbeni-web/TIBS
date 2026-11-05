import { z } from "zod";
import { idContestation, nouvelleFiche, type Contestation } from "@/lib/contestations";
import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";

/**
 * Suivi des contestations Uber Eats, lu et écrit par le serveur (aucune règle Firestore à publier).
 *   GET    /api/uber-contestations?r=19e                     → { fiches }
 *   POST   /api/uber-contestations?r=19e { lignes: [...] }   → importe les lignes copiées d'Uber Eats Manager
 *   PATCH  /api/uber-contestations?r=19e { id, champs }      → met à jour le suivi d'une fiche
 *   DELETE /api/uber-contestations?r=19e&id=…
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const centimes = z.number().int().min(0).max(100_000_00);
const ETAT = z.enum(["probleme_facture", "rembourse_uber", "contestation_refusee", "autre"]);

const Ligne = z.object({
  commande: z.string().trim().regex(/^[0-9A-Za-z]{3,12}$/),
  dateCommande: date,
  heure: z.string().max(5).optional(),
  client: z.string().max(80).optional(),
  motif: z.string().max(120),
  etatUber: ETAT,
  justificatif: z.boolean(),
});

const Champs = z
  .object({
    motif: z.string().max(120),
    etatUber: ETAT,
    montant: centimes.nullable(),
    dateReclamation: date.nullable(),
    dateContestation: date.nullable(),
    commentaire: z.string().max(2000),
    issue: z.enum(["a_contester", "contestee", "acceptee", "refusee", "abandonnee"]),
    dateReponse: date.nullable(),
    montantRecupere: centimes.nullable(),
    dateVersement: date.nullable(),
    note: z.string().max(1000),
    client: z.string().max(80),
    heure: z.string().max(5),
  })
  .partial();

async function contexte(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  return adminDb().collection(`restaurants/${rid}/uberContestations`);
}

export async function GET(request: Request) {
  const col = await contexte(request);
  if (col instanceof Response) return col;
  const snap = await col.orderBy("dateCommande", "desc").get();
  return Response.json({ fiches: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
}

export async function POST(request: Request) {
  const col = await contexte(request);
  if (col instanceof Response) return col;
  const body = z.object({ lignes: z.array(Ligne).min(1).max(500) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Lignes illisibles." }, { status: 400 });

  let ajoutees = 0, misesAJour = 0, inchangees = 0;
  const maintenant = Date.now();
  const refs = body.data.lignes.map((l) => col.doc(idContestation(l.commande, l.dateCommande)));
  const existants = await col.firestore.getAll(...refs);
  const batch = col.firestore.batch();
  body.data.lignes.forEach((l, i) => {
    const ex = existants[i];
    if (!ex.exists) {
      batch.set(refs[i], nouvelleFiche(l, maintenant));
      ajoutees++;
      return;
    }
    const f = ex.data() as Contestation;
    const maj: Partial<Contestation> = {};
    if (l.etatUber !== f.etatUber && l.etatUber !== "autre") maj.etatUber = l.etatUber;
    // Uber affiche « Contestation refusée » : la fiche contestée passe en refusée.
    if (l.etatUber === "contestation_refusee" && f.issue === "contestee") maj.issue = "refusee";
    if (l.justificatif && !f.justificatif) maj.justificatif = true;
    if (Object.keys(maj).length) {
      batch.update(refs[i], { ...maj, updatedAt: maintenant });
      misesAJour++;
    } else inchangees++;
  });
  await batch.commit();
  return Response.json({ ok: true, ajoutees, misesAJour, inchangees });
}

export async function PATCH(request: Request) {
  const col = await contexte(request);
  if (col instanceof Response) return col;
  const body = z.object({ id: z.string().min(1).max(40), champs: Champs }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Modification illisible." }, { status: 400 });
  const ref = col.doc(body.data.id);
  if (!(await ref.get()).exists) return Response.json({ error: "Fiche introuvable." }, { status: 404 });
  const { FieldValue } = await import("firebase-admin/firestore");
  // null ou "" efface le champ.
  const maj = Object.fromEntries(
    Object.entries(body.data.champs).map(([k, v]) => [k, v === null || v === "" ? FieldValue.delete() : v]),
  );
  await ref.update({ ...maj, updatedAt: Date.now() });
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const col = await contexte(request);
  if (col instanceof Response) return col;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id manquant" }, { status: 400 });
  await col.doc(id).delete();
  return Response.json({ ok: true });
}
