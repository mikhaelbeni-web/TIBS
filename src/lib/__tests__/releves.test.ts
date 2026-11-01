import { describe, expect, it } from "vitest";
import { cleEcart, estCoherent, normNumero, rapprocher, type Releve } from "../releves";
import type { Invoice, WithId } from "../types";

const f = (id: string, numero: string, ttc: number, date = "2026-10-10", statut: Invoice["statut"] = "a_payer"): WithId<Invoice> => ({
  id,
  supplierId: "s",
  supplierNom: "S",
  numero,
  dateFacture: date,
  mois: date.slice(0, 7),
  montantHT: ttc,
  montantTVA: 0,
  montantTTC: ttc,
  statut,
  createdAt: 0,
});
const rel = (lignes: Releve["lignes"], extra: Partial<Releve> = {}): Releve => ({
  fournisseur: "S",
  mois: "2026-10",
  periodeDebut: "2026-10-01",
  periodeFin: "2026-10-31",
  lignes,
  totalTTC: lignes.reduce((t, l) => t + l.montantTTC, 0),
  coherent: true,
  source: { messageId: "m" },
  createdAt: 0,
  ...extra,
});

describe("relevés fournisseurs", () => {
  it("normalise les numéros", () => {
    expect(normNumero("FAC-000123")).toBe("123");
    expect(normNumero("n° 45/A")).toBe("45A");
  });

  it("tout correspond : on paie le net du relevé", () => {
    const r = rapprocher(rel([{ numero: "FAC-1", montantTTC: 1000 }, { numero: "2", montantTTC: 500 }], { netAPayer: 1500 }), [f("a", "1", 1000), f("b", "FAC2", 500)]);
    expect(r.ecarts).toBe(0);
    expect(r).toMatchObject({ base: "releve", aPayer: 1500 });
  });

  it("détecte facture non reçue, montant différent, facture absente du relevé", () => {
    const r = rapprocher(
      rel([
        { numero: "1", montantTTC: 1000 },
        { numero: "2", montantTTC: 700 },
        { numero: "3", montantTTC: 300 },
      ]),
      [f("a", "1", 1000), f("b", "2", 650), f("c", "9", 200)],
      ["3"],
    );
    expect(r.lignes.map((l) => l.etat)).toEqual(["ok", "montant", "en_attente"]);
    expect(r.absentes.map((x) => x.numero)).toEqual(["9"]);
    expect(r.ecarts).toBe(3);
    // On ne paie que les pièces que l'on a : 1000 + 650 + 200.
    expect(r).toMatchObject({ base: "factures", aPayer: 1850 });
  });

  it("facture d'un autre mois listée : hors période ; montant + date = probable", () => {
    const r = rapprocher(rel([{ numero: "1", montantTTC: 1000 }, { numero: "X", date: "2026-10-12", montantTTC: 400 }]), [
      f("a", "1", 1000, "2026-09-30"),
      f("b", "77", 400, "2026-10-11"),
    ]);
    expect(r.lignes[0]).toMatchObject({ etat: "ok", horsPeriode: true });
    expect(r.lignes[1].etat).toBe("probable");
  });

  it("écart justifié à la main", () => {
    const r = rapprocher(rel([{ numero: "5", montantTTC: 100 }], { justifies: { [cleEcart("ligne", "5")]: "facture perdue, demandée" } }), []);
    expect(r.ecarts).toBe(0);
  });

  it("cohérence : somme des lignes = total imprimé", () => {
    expect(estCoherent({ lignes: [{ numero: "1", montantTTC: 1000 }], totalTTC: 1000 })).toBe(true);
    expect(estCoherent({ lignes: [{ numero: "1", montantTTC: 1000 }], totalTTC: 5000 })).toBe(false);
  });
});
