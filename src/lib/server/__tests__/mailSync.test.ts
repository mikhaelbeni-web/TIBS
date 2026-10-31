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
      headers: [{ name: "From", value: "Metro <factures@metro.fr>" }, { name: "Subject", value: "Votre facture 4521" }],
      parts: [{ mimeType: "application/pdf", filename: "F4521.pdf", body: { attachmentId: "a1", size: 2000 } }],
    },
  },
  m2: {
    id: "m2",
    internalDate: String(Date.UTC(2026, 9, 15)),
    payload: {
      headers: [{ name: "From", value: "Uber Eats <noreply@uber.com>" }, { name: "Subject", value: "Votre paiement Uber Eats" }],
      parts: [{ mimeType: "text/html", body: { data: b64("<p>Paiement : 812,40 €</p>"), size: 30 } }],
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
    if (url.includes("/users/me/messages?")) return json({ messages: [{ id: "m3" }, { id: "m2" }, { id: "m1" }] });
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
    expect(r).toMatchObject({ status: "ok", messagesVus: 3, nouveaux: 2, ignores: 1, erreurs: 0 });

    const inbox = (await db.collection("inbox").get()).docs.map((d) => ({ id: d.id, ...d.data() }) as { id: string; item: Record<string, unknown> });
    const facture = inbox.find((d) => d.id === "m1_0")!.item;
    expect(facture).toMatchObject({ kind: "facture", fournisseur: "Metro", incomplet: true });
    expect(facture.source).toMatchObject({ messageId: "m1", attachment: "F4521.pdf" });
    expect(inbox.find((d) => d.id === "m2_0")!.item).toMatchObject({ kind: "uber", date: "2026-10-15", incomplet: true });

    const again = await syncMail();
    expect(again).toMatchObject({ messagesVus: 0, nouveaux: 0 });
    expect((await db.doc("settings/mail").get()).get("dernierResultat.nouveaux")).toBe(0);
  });
});
