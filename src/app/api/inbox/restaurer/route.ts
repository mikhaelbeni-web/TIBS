import { FieldValue } from "firebase-admin/firestore";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { adminDb } from "@/lib/server/admin";

/**
 * POST /api/inbox/restaurer?r=19e&i=<id> (gérant) : remet dans « À vérifier » un élément ignoré par erreur,
 * ou une facture validée automatiquement (la facture créée est alors retirée).
 * Passe par le serveur pour ne pas élargir les règles Firestore (le navigateur ne peut que valider ou ignorer).
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const id = new URL(request.url).searchParams.get("i");
  if (!id || !/^[A-Za-z0-9_-]{1,140}$/.test(id)) return Response.json({ error: "Élément inconnu." }, { status: 400 });

  const db = adminDb();
  const ref = db.doc(`restaurants/${rid}/inbox/${id}`);
  const snap = await ref.get();
  if (!snap.exists) return Response.json({ error: "Élément introuvable." }, { status: 404 });

  // Facture validée automatiquement : on retire la facture créée et la ligne revient « À vérifier »,
  // sans plus jamais être validée toute seule.
  if (snap.get("statut") === "valide" && snap.get("auto") === true && snap.get("item.kind") === "facture") {
    const err = await db.runTransaction(async (tx) => {
      const fresh = await tx.get(ref);
      if (fresh.get("statut") !== "valide") return "Cet élément a déjà été traité.";
      const factureId = fresh.get("factureId") as string | undefined;
      if (factureId) {
        const inv = db.doc(`restaurants/${rid}/invoices/${factureId}`);
        const f = await tx.get(inv);
        if (f.exists && f.get("statut") !== "a_payer") return "La facture est déjà marquée payée ou en litige : corrige-la dans Factures.";
        if (f.exists) tx.delete(inv);
      }
      tx.update(ref, {
        statut: "a_verifier",
        remiseAVerifier: true,
        doutes: ["remise_a_verifier"],
        auto: FieldValue.delete(),
        factureId: FieldValue.delete(),
        traiteLe: FieldValue.delete(),
      });
      return null;
    });
    if (err) return Response.json({ error: err }, { status: 409 });
    return Response.json({ status: "ok" });
  }

  if (snap.get("statut") !== "rejete") return Response.json({ error: "Seul un élément ignoré ou validé automatiquement peut être remis à vérifier." }, { status: 409 });
  await ref.update({ statut: "a_verifier", traiteLe: FieldValue.delete() });
  return Response.json({ status: "ok" });
}
