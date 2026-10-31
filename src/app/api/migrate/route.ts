import { adminDb } from "@/lib/server/admin";
import { requireGerant } from "@/lib/server/authz";

const LEGACY = ["employees", "suppliers", "invoices", "cashEntries", "bankTransactions", "uberPayouts", "inbox", "settings", "mailLog", "private"];

/**
 * POST /api/migrate (gérant) : une seule fois, recopie les données saisies avant le passage aux deux portails
 * (collections à la racine) dans le portail Manin 19e. Les originaux restent en place comme sauvegarde.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const db = adminDb();
  const target = db.doc("restaurants/19e");
  if ((await target.get()).get("migreLe")) return Response.json({ deja: true });

  const copies: Record<string, number> = {};
  for (const name of LEGACY) {
    const snap = await db.collection(name).get();
    for (let i = 0; i < snap.docs.length; i += 400) {
      const batch = db.batch();
      for (const d of snap.docs.slice(i, i + 400)) batch.set(target.collection(name).doc(d.id), d.data(), { merge: true });
      await batch.commit();
    }
    if (snap.size) copies[name] = snap.size;
  }
  await target.set({ migreLe: Date.now(), migrePar: uid, copies }, { merge: true });
  return Response.json({ copies });
}
