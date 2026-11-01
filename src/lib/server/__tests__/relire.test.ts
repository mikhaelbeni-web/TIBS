import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Relecture des PDF « à compléter » (émulateur Firestore, Google et Claude simulés). */
const run = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;

vi.mock("../extract", () => ({
  extractionEnabled: () => true,
  extractFacture: vi.fn(async () => ({ fournisseur: "HALLES PARIS SUD SAS", numero: "FAC-1", dateFacture: "2026-10-09", montantHT: 10000, montantTVA: 550, montantTTC: 10550 })),
  extractUber: vi.fn(async () => null),
  estReleve: (r: { kind?: string }) => r?.kind === "releve",
  Lecteur: class {
    actif = true;
    lectures = 0;
    entree = 0;
    sortie = 0;
    cout = 0;
    limite = null;
    peutLire = () => true;
    compter() {}
  },
}));

const msg = {
  id: "r1",
  internalDate: String(Date.UTC(2026, 9, 10)),
  payload: {
    headers: [{ name: "From", value: "HPS <comptabilite@hpsrungis.com>" }, { name: "Subject", value: "Facture" }],
    parts: [{ mimeType: "application/pdf", filename: "FAC-1.pdf", body: { attachmentId: "a1", size: 2000 } }],
  },
};

beforeAll(() => {
  process.env.GOOGLE_CLIENT_ID = "id";
  process.env.GOOGLE_CLIENT_SECRET = "secret";
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at" });
    if (url.includes("/messages/r1/attachments/a1")) return json({ data: Buffer.from("%PDF").toString("base64url") });
    if (url.includes("/messages/r1?format=full")) return json(msg);
    return real(input, init);
  });
});
afterAll(() => vi.unstubAllGlobals());

run("relireIncomplets (émulateur)", () => {
  it("complète une facture sans écraser ce qui est saisi", async () => {
    const { adminDb } = await import("../admin");
    const { relireIncomplets } = await import("../mailSync");
    const db = adminDb();
    for (const d of (await db.collection("restaurants/19e/inbox").get()).docs) await d.ref.delete();
    await db.doc("restaurants/19e/private/gmail").set({ refreshToken: "rt" });
    await db.doc("restaurants/19e/inbox/r1_0").set({
      statut: "a_verifier",
      receivedAt: 1,
      item: { kind: "facture", fournisseur: "Halles Paris Sud", numero: "FAC-1", incomplet: true, source: { messageId: "r1", attachment: "FAC-1.pdf" } },
    });
    const r = await relireIncomplets("19e");
    expect(r).toMatchObject({ status: "ok", relus: 1, completes: 1, restants: 0 });
    const item = (await db.doc("restaurants/19e/inbox/r1_0").get()).get("item");
    expect(item).toMatchObject({ fournisseur: "Halles Paris Sud", numero: "FAC-1", dateFacture: "2026-10-09", montantTTC: 10550, montantTVA: 550 });
    expect(item.incomplet).toBeUndefined();
  });

  it("note « pas une facture », ne la relit plus seule, sauf à la demande", async () => {
    const { adminDb } = await import("../admin");
    const { relireIncomplets } = await import("../mailSync");
    const { extractFacture } = await import("../extract");
    const db = adminDb();
    const ref = db.doc("restaurants/19e/inbox/r1_0");
    await ref.set({
      statut: "a_verifier",
      receivedAt: 1,
      item: { kind: "facture", fournisseur: "X", incomplet: true, lecture: "limite", source: { messageId: "r1", attachment: "FAC-1.pdf" } },
    });
    vi.mocked(extractFacture).mockResolvedValueOnce(null);
    expect(await relireIncomplets("19e")).toMatchObject({ relus: 1, completes: 0 });
    expect((await ref.get()).get("item.lecture")).toBe("pas_facture");

    expect(await relireIncomplets("19e")).toMatchObject({ relus: 0, restants: 0 });
    expect(await relireIncomplets("19e", { ids: ["r1_0"] })).toMatchObject({ relus: 1, completes: 1 });
    expect((await ref.get()).get("item.lecture")).toBeUndefined();
  });

  it("un récapitulatif devient un relevé et sort de « À vérifier »", async () => {
    const { adminDb } = await import("../admin");
    const { relireIncomplets } = await import("../mailSync");
    const { extractFacture } = await import("../extract");
    const db = adminDb();
    for (const d of (await db.collection("restaurants/19e/releves").get()).docs) await d.ref.delete();
    const ref = db.doc("restaurants/19e/inbox/r1_0");
    await ref.set({ statut: "a_verifier", receivedAt: 1, item: { kind: "facture", fournisseur: "PREMIUM DISTRIB", incomplet: true, source: { messageId: "r1", attachment: "FAC-1.pdf" } } });
    vi.mocked(extractFacture).mockResolvedValueOnce({
      kind: "releve",
      numero: "R-10",
      periodeDebut: "2026-10-01",
      periodeFin: "2026-10-31",
      totalTTC: 30000,
      lignes: [
        { numero: "F1", montantTTC: 10000 },
        { numero: "F2", montantTTC: 20000 },
      ],
    } as never);
    await relireIncomplets("19e");
    expect((await ref.get()).get("statut")).toBe("releve");
    const rel = (await db.collection("restaurants/19e/releves").get()).docs;
    expect(rel).toHaveLength(1);
    expect(rel[0].data()).toMatchObject({ fournisseur: "PREMIUM DISTRIB", mois: "2026-10", coherent: true, totalTTC: 30000 });
  });
});
