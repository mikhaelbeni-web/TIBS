import { FieldValue } from "firebase-admin/firestore";
import { header } from "@/lib/mail";
import { construireMail } from "@/lib/mime";
import { emailValide, type Reclamation } from "@/lib/reclamation";
import { isRestaurantId, restaurant } from "@/lib/restaurants";
import { adminDb } from "@/lib/server/admin";
import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { getMessage, GoogleAuthError, refreshAccessToken, sendRawMessage } from "@/lib/server/google";

/**
 * POST /api/releves/reclamer?r=19e (gérant) { releveId, a, objet, corps, numeros } :
 * envoie au fournisseur, depuis la boîte Gmail qui a reçu le relevé, le mail qui réclame les factures manquantes.
 * Jamais appelé automatiquement : seulement par le bouton « Envoyer », après aperçu du mail.
 * Réponse 409 { code: "envoi" } si la boîte n'a pas encore autorisé l'envoi.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;

  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const releveId = typeof b?.releveId === "string" ? b.releveId : "";
  const a = typeof b?.a === "string" ? b.a.trim() : "";
  const objet = typeof b?.objet === "string" ? b.objet.trim() : "";
  const corps = typeof b?.corps === "string" ? b.corps.trim() : "";
  const numeros = Array.isArray(b?.numeros) ? b.numeros.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, 60)).slice(0, 60) : [];
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(releveId)) return Response.json({ error: "Relevé inconnu." }, { status: 400 });
  if (!emailValide(a)) return Response.json({ error: "Adresse du fournisseur invalide." }, { status: 400 });
  if (!objet || objet.length > 250 || !corps || corps.length > 6000) return Response.json({ error: "Objet ou texte du mail vide ou trop long." }, { status: 400 });

  const db = adminDb();
  const ref = db.doc(`restaurants/${rid}/releves/${releveId}`);
  const snap = await ref.get();
  if (!snap.exists) return Response.json({ error: "Relevé introuvable." }, { status: 404 });

  // Anti double clic : même relevé réclamé il y a moins de 2 minutes.
  const precedentes = (snap.get("reclamations") as Reclamation[] | undefined) ?? [];
  if (precedentes.some((x) => Date.now() - x.le < 120_000)) return Response.json({ error: "Mail déjà envoyé il y a moins de 2 minutes." }, { status: 409 });

  // Répondre depuis la boîte qui a reçu le relevé, dans le même fil.
  const source = (snap.get("source") ?? {}) as { messageId?: string; boite?: string };
  const boite = isRestaurantId(source.boite) ? source.boite : rid;
  const gmail = await db.doc(`restaurants/${boite}/private/gmail`).get();
  const refresh = gmail.get("refreshToken") as string | undefined;
  if (!refresh) return Response.json({ error: `Boîte Gmail ${restaurant(boite).court} non connectée.`, code: "envoi", boite }, { status: 409 });
  if (gmail.get("envoi") !== true) return Response.json({ error: "La boîte n'a pas encore autorisé l'envoi de mails depuis l'app.", code: "envoi", boite }, { status: 409 });

  try {
    const token = await refreshAccessToken(refresh);
    let threadId: string | undefined;
    let enReponseA: string | undefined;
    if (source.messageId) {
      const orig = await getMessage(token, source.messageId).catch(() => null);
      if (orig) {
        threadId = orig.threadId;
        enReponseA = header(orig, "Message-ID") || undefined;
      }
    }
    const adresse = (gmail.get("adresse") as string | undefined) ?? restaurant(boite).boiteMail;
    const raw = construireMail({ de: `"${restaurant(boite).nom}" <${adresse}>`, a, objet, corps, enReponseA });
    const envoye = await sendRawMessage(token, raw, threadId);
    const rec: Reclamation = { le: Date.now(), a, numeros, objet, messageId: envoye.id, par: uid };
    await ref.update({ reclamations: FieldValue.arrayUnion(rec) });
    return Response.json({ ok: true, le: rec.le, de: adresse });
  } catch (e) {
    if (e instanceof GoogleAuthError) {
      if (/autorisé l'envoi/.test(e.message)) await db.doc(`restaurants/${boite}/private/gmail`).set({ envoi: false }, { merge: true });
      return Response.json({ error: e.message, code: "envoi", boite }, { status: 409 });
    }
    console.error("reclamer:", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
