import { requireGerant, restaurantParam } from "@/lib/server/authz";
import { adminDb } from "@/lib/server/admin";
import { getAttachment, getMessage, GoogleAuthError, refreshAccessToken } from "@/lib/server/google";
import { pdfAttachments } from "@/lib/mail";
import type { InboxItem } from "@/lib/ingest";

const err = (status: number, error: string) => Response.json({ error }, { status });

/**
 * POST /api/gmail/pdf?r=19e&i=<id inbox> (gérant) : renvoie le PDF joint au mail d'un élément « À vérifier ».
 * On ne prend que des éléments déjà dans la boîte du restaurant : pas d'accès à un mail arbitraire.
 */
export async function POST(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  const rid = restaurantParam(request);
  if (rid instanceof Response) return rid;
  const id = new URL(request.url).searchParams.get("i") ?? "";
  if (!/^[A-Za-z0-9_-]{1,140}$/.test(id)) return err(400, "Élément inconnu.");

  const home = adminDb().doc(`restaurants/${rid}`);
  const snap = await home.collection("inbox").doc(id).get();
  const item = snap.get("item") as InboxItem | undefined;
  const messageId = item?.source?.messageId;
  if (!messageId) return err(404, "Élément introuvable.");
  const refreshToken = (await home.collection("private").doc("gmail").get()).get("refreshToken") as string | undefined;
  if (!refreshToken) return err(409, "Boîte Gmail non connectée.");

  try {
    const token = await refreshAccessToken(refreshToken);
    const msg = await getMessage(token, messageId);
    const pdfs = pdfAttachments(msg);
    const pdf = pdfs.find((p) => p.filename === item.source?.attachment) ?? pdfs[0];
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
    if (e instanceof GoogleAuthError) return err(409, "Accès Gmail expiré : reconnecte la boîte dans « À vérifier ».");
    return err(502, `Gmail : ${(e as Error).message}`.slice(0, 300));
  }
}
