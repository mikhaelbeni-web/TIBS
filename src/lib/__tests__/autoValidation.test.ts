import { describe, expect, it } from "vitest";
import { doutesFacture, type ContexteValidation } from "@/lib/autoValidation";
import type { InboxFacture } from "@/lib/ingest";

const facture = (o: Partial<InboxFacture> = {}): InboxFacture => ({
  kind: "facture",
  fournisseur: "HPS Rungis",
  numero: "FAC-1",
  dateFacture: "2026-11-02",
  montantHT: 10_000,
  montantTVA: 550,
  montantTTC: 10_550,
  source: { messageId: "m1", from: "HPS <comptabilite@hpsrungis.com>" },
  ...o,
});
const ctx = (o: Partial<ContexteValidation> = {}): ContexteValidation => ({ aujourdhui: "2026-11-05", restaurant: "19e", recuLe: "2026-11-03", fournisseurConnu: true, doublon: false, historiqueTTC: [], ...o });

describe("doutesFacture", () => {
  it("valide une facture cohérente", () => {
    expect(doutesFacture(facture(), ctx())).toEqual([]);
    // TVA mixte 5,5 % + 20 %, arrondi d'un centime
    expect(doutesFacture(facture({ montantHT: 20_000, montantTVA: 2_550, montantTTC: 22_551 }), ctx())).toEqual([]);
  });
  it("garde les lectures douteuses", () => {
    expect(doutesFacture(facture({ montantTTC: 10_600 }), ctx())).toEqual(["calcul"]);
    expect(doutesFacture(facture({ montantHT: undefined }), ctx())).toEqual(["montants_absents"]);
    expect(doutesFacture(facture({ numero: "" }), ctx())).toEqual(["sans_numero"]);
    expect(doutesFacture(facture({ dateFacture: "2026-12-01" }), ctx())).toEqual(["date_future"]);
    expect(doutesFacture(facture({ dateFacture: "2025-01-01" }), ctx())).toEqual(["date_ancienne"]);
    // Jour et mois inversés (11/04 au lieu de 04/11) : trop loin avant le mail.
    expect(doutesFacture(facture({ dateFacture: "2026-04-11" }), ctx())).toEqual(["date_ancienne"]);
    expect(doutesFacture(facture({ dateFacture: "2026-09-20" }), ctx({ recuLe: "2026-10-01" }))).toEqual(["mois_ancien"]);
    expect(doutesFacture(facture({ dateFacture: "2026-10-20" }), ctx())).toEqual([]);
    expect(doutesFacture(facture({ source: { messageId: "m", subject: "Votre relevé de factures octobre" } }), ctx())).toEqual(["type_document"]);
    expect(doutesFacture(facture({ source: { messageId: "m", attachment: "BL_12345.pdf" } }), ctx())).toEqual(["type_document"]);
    expect(doutesFacture(facture({ source: { messageId: "m", subject: "Facture FAC-20261009 Blé" } }), ctx())).toEqual([]);
    expect(doutesFacture(facture({ etablissementPdf: "17e" }), ctx())).toEqual(["autre_restaurant"]);
    expect(doutesFacture(facture({ montantHT: 250_000, montantTVA: 13_750, montantTTC: 263_750 }), ctx())).toEqual(["montant_eleve"]);
    expect(doutesFacture(facture({ montantHT: 10_000, montantTVA: 3_000, montantTTC: 13_000 }), ctx())).toEqual(["taux_tva"]);
    expect(doutesFacture(facture({ montantHT: -10_000, montantTVA: -550, montantTTC: -10_550 }), ctx())).toEqual(["avoir"]);
    expect(doutesFacture(facture({ lecture: "erreur" }), ctx())).toEqual(["lecture"]);
  });
  it("tient compte du contexte", () => {
    expect(doutesFacture(facture(), ctx({ fournisseurConnu: false }))).toEqual(["fournisseur_inconnu"]);
    expect(doutesFacture(facture(), ctx({ doublon: true }))).toEqual(["doublon"]);
    expect(doutesFacture(facture(), ctx({ remiseAVerifier: true }))).toEqual(["remise_a_verifier"]);
    expect(doutesFacture(facture(), ctx({ plusieursFactures: true }))).toEqual(["plusieurs_factures"]);
    expect(doutesFacture(facture(), ctx({ historiqueTTC: [2_000, 3_000, 3_400] }))).toEqual(["montant_inhabituel"]);
    expect(doutesFacture(facture(), ctx({ historiqueTTC: [2_000, 3_000] }))).toEqual([]);
  });
});
