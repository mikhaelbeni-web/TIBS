import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Relevé complet contre l'émulateur Firestore, avec Google simulé.
 * Lancé seulement si FIRESTORE_EMULATOR_HOST est défini (npm run emulators).
 */
const run = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
const b64 = (s: string) => Buffer.from(s).toString("base64url");

const messages: Record<string, unknown> = {
  m1: {
    id: "m1",
    internalDate: String(Date.UTC(2026, 9, 10)),
    payload: {
      headers: [{ name: "From", value: "HPS <comptabilite@hpsrungis.com>" }, { name: "Subject", value: "Facture FAC-20261009-004512" }],
      parts: [{ mimeType: "application/octet-stream", filename: "FAC-20261009-004512.pdf", body: { attachmentId: "a1", size: 2000 } }],
    },
  },
  m2: {
    id: "m2",
    internalDate: String(Date.UTC(2026, 9, 15)),
    payload: {
      headers: [
        { name: "From", value: "Uber Eats <noreply@uber.com>" },
        { name: "Subject", value: "Récapitulatif des versements Uber Eats pour Tib's (K) Oct 5, 2026 - Oct 11, 2026" },
      ],
      parts: [{ mimeType: "text/html", body: { data: b64("<tr><td>Revenus totaux</td><td>7 806,50 €</td></tr><tr><td>Total des frais Uber</td><td>-1 840,69 €</td></tr><tr><td>Versement bancaire</td><td>4 781,33 €</td></tr>"), size: 30 } }],
    },
  },
  m4: {
    id: "m4",
    internalDate: String(Date.UTC(2026, 9, 11)),
    payload: {
      headers: [{ name: "From", value: "HPS <comptabilite@hpsrungis.com>" }, { name: "Subject", value: "[DUPLICATA] Facture FAC-20261009-004512" }],
      parts: [{ mimeType: "application/pdf", filename: "FAC-20261009-004512.pdf", body: { attachmentId: "a4", size: 2000 } }],
    },
  },
  m5: {
    id: "m5",
    internalDate: String(Date.UTC(2026, 9, 12)),
    payload: {
      headers: [{ name: "From", value: "IMS Cash <ims-cash@invoicing.pennylane.com>" }, { name: "Subject", value: "Votre facture" }, { name: "Cc", value: "letibsprony17@gmail.com" }],
      parts: [{ mimeType: "text/plain", body: { data: b64("Facture F-2026-09-162 d'un montant de 58,00 € à régler avant le 23/10/2026"), size: 80 } }],
    },
  },
  m3: {
    id: "m3",
    internalDate: String(Date.UTC(2026, 9, 16)),
    payload: { headers: [{ name: "From", value: "Ami <a@gmail.com>" }, { name: "Subject", value: "Photos" }], parts: [{ mimeType: "application/pdf", filename: "album.pdf", body: { attachmentId: "a3", size: 10 } }] },
  },
};

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  delete process.env.ANTHROPIC_API_KEY;
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at" });
    if (url.includes("/users/me/messages?")) return json({ messages: [{ id: "m5" }, { id: "m4" }, { id: "m3" }, { id: "m2" }, { id: "m1" }] });
    const m = url.match(/\/users\/me\/messages\/(\w+)\?format=full/);
    if (m) return json(messages[m[1]]);
    return real(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

run("syncMail (émulateur)", () => {
  it("relève les mails une seule fois", async () => {
    const { adminDb } = await import("../admin");
    const { syncMail } = await import("../mailSync");
    const db = adminDb();
    for (const c of ["inbox", "mailLog"]) for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
    await db.doc("settings/mail").delete();
    await db.doc("private/gmail").delete();

    expect((await syncMail()).status).toBe("non_connecte");

    await db.doc("private/gmail").set({ refreshToken: "rt", adresse: "resto@gmail.com" });
    const r = await syncMail();
    expect(r).toMatchObject({ status: "ok", messagesVus: 5, nouveaux: 3, doublons: 1, erreurs: 0 });

    const inbox = (await db.collection("inbox").get()).docs.map((d) => ({ id: d.id, ...d.data() }) as { id: string; item: Record<string, unknown> });
    const hps = inbox.find((d) => d.id === "m1_0")!.item;
    expect(hps).toMatchObject({ kind: "facture", fournisseur: "Halles Paris Sud", numero: "FAC-20261009-004512", dateFacture: "2026-10-09", incomplet: true });
    expect(hps.source).toMatchObject({ messageId: "m1", attachment: "FAC-20261009-004512.pdf" });
    expect(inbox.find((d) => d.id === "m2_0")!.item).toMatchObject({ kind: "uber", date: "2026-10-15", montant: 478133, frais: 184069, brut: 780650 });
    expect(inbox.find((d) => d.id === "m2_0")!.item.incomplet).toBeUndefined();
    expect(inbox.find((d) => d.id === "m5_0")!.item).toMatchObject({ fournisseur: "IMS Cash", montantTTC: 5800, etablissement: "17e", incomplet: true });
    expect(inbox.some((d) => d.id === "m4_0")).toBe(false);

    const again = await syncMail();
    expect(again).toMatchObject({ messagesVus: 0, nouveaux: 0 });
    expect((await db.doc("settings/mail").get()).get("dernierResultat.nouveaux")).toBe(0);
  });
});
