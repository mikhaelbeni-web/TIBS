import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { adminDb } from "@/lib/server/admin";
import { getAttachment, getMessage, GoogleAuthError } from "@/lib/server/google";
import { jetonBoite } from "@/lib/server/mailSync";
import { restaurant } from "@/lib/restaurants";
import { pdfAttachments } from "@/lib/mail";
import type { InboxDoc, InboxItem, InboxSource } from "@/lib/ingest";
import { inboxDeLaFacture } from "@/lib/factureSource";

const err = (status: number, error: string) => Response.json({ error }, { status });

/**
 * POST /api/gmail/pdf?r=19e&i=<id inbox> (gérant) : renvoie le PDF joint au mail d'un élément « À vérifier ».
 * POST /api/gmail/pdf?r=19e&f=<id facture> : PDF du mail d'où vient une facture validée (page Factures).
 * On ne prend que des éléments déjà dans la boîte du restaurant : pas d'accès à un mail arbitraire.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const params = new URL(request.url).searchParams;
  const releve = params.get("c") === "releve";
  const factureId = params.get("f");
  const valide = (x: string) => /^[A-Za-z0-9_-]{1,150}$/.test(x);
  const home = adminDb().doc(`restaurants/${rid}`);
  let id = params.get("i") ?? "";
  if (factureId !== null) {
    if (!valide(factureId)) return err(400, "Facture inconnue.");
    const inv = await home.collection("invoices").doc(factureId).get();
    if (!inv.exists) return err(404, "Facture introuvable.");
    id = (inv.get("inboxId") as string | undefined) ?? "";
    const numero = String(inv.get("numero") ?? "").trim();
    if (!id && numero) {
      // Factures validées à la main avant l'enregistrement de l'id du mail : retrouvées par leur numéro.
      const q = await home.collection("inbox").where("item.numero", "==", numero).limit(10).get();
      id =
        inboxDeLaFacture(
          { numero, montantTTC: Number(inv.get("montantTTC")), supplierNom: String(inv.get("supplierNom") ?? "") },
          q.docs.map((d) => ({ id: d.id, data: d.data() as InboxDoc })),
        ) ?? "";
    }
    if (!id) return err(404, "Pas de PDF pour cette facture : elle a été saisie à la main, pas reçue par mail.");
  }
  if (!valide(id)) return err(400, "Élément inconnu.");

  const snap = await home.collection(releve ? "releves" : "inbox").doc(id).get();
  const source = (releve ? snap.get("source") : (snap.get("item") as InboxItem | undefined)?.source) as InboxSource | undefined;
  const messageId = source?.messageId;
  if (!source || !messageId) return err(404, "Élément introuvable.");
  const boite = source.boite ?? rid;

  try {
    const token = await jetonBoite(boite);
    if (!token) return err(409, `Boîte Gmail ${restaurant(boite).court} non connectée.`);
    const msg = await getMessage(token, messageId);
    const pdfs = pdfAttachments(msg);
    const pdf = pdfs.find((p) => p.filename === source.attachment) ?? pdfs[0];
    if (!pdf) return err(404, "Ce mail n'a pas de PDF.");
    const b64 = pdf.data ? Buffer.from(pdf.data, "base64url").toString("base64") : await getAttachment(token, messageId, pdf.attachmentId!);
    const name = pdf.filename.replace(/[^\w.\- ]/g, "_");
    return new Response(Buffer.from(b64, "base64"), {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${name}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (e) {
    if (e instanceof GoogleAuthError) return err(409, `Accès Gmail expiré : reconnecte la boîte ${restaurant(boite).court} dans « À vérifier ».`);
    return err(502, `Gmail : ${(e as Error).message}`.slice(0, 300));
  }
}
