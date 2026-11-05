import { describe, expect, it } from "vitest";
import { centimes, debutReleve, joursRestants, lignesDuCompte, releveBanqueDu, sansDoublonsImport, trierBanques, versLigne } from "../banque";

describe("banque DSP2", () => {
  it("convertit les montants texte en centimes", () => {
    expect(centimes("123.45")).toBe(12345);
    expect(centimes("10.5")).toBe(1050);
    expect(centimes("7")).toBe(700);
    expect(centimes("-0.99")).toBe(-99);
    expect(centimes("abc")).toBeNull();
  });

  it("signe le montant selon crédit / débit et compose le libellé", () => {
    expect(
      versLigne({ transaction_amount: { amount: "42.10", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-11-03", remittance_information: ["PRLV SEPA", " METRO  France "] }),
    ).toEqual({ date: "2026-11-03", libelle: "PRLV SEPA METRO France", montant: -4210, ref: undefined });
    expect(versLigne({ transaction_amount: { amount: "980" }, credit_debit_indicator: "CRDT", value_date: "2026-11-04", debtor: { name: "UBER EATS" }, entry_reference: "X1" })).toEqual({
      date: "2026-11-04",
      libelle: "UBER EATS",
      montant: 98000,
      ref: "X1",
    });
  });

  it("ignore les opérations en attente", () => {
    expect(versLigne({ transaction_amount: { amount: "1" }, status: "PDNG", booking_date: "2026-11-01" })).toBeNull();
  });

  it("donne des identifiants stables, distincts pour deux opérations identiques sans référence", () => {
    const t = { transaction_amount: { amount: "3.50" }, credit_debit_indicator: "DBIT", booking_date: "2026-11-02", remittance_information: ["CAFE"] };
    const a = lignesDuCompte("acc1", [t, t]);
    const b = lignesDuCompte("acc1", [t, t]);
    expect(a.map((l) => l.id)).toEqual(b.map((l) => l.id));
    expect(a[0].id).not.toBe(a[1].id);
    expect(a[0].id.startsWith("eb_2026-11-02_")).toBe(true);
    expect(lignesDuCompte("acc2", [t])[0].id).not.toBe(a[0].id);
  });

  it("écarte une opération déjà importée par fichier (même date et montant), une seule fois", () => {
    const l = [
      { date: "2026-11-02", montant: 1000 },
      { date: "2026-11-02", montant: 1000 },
      { date: "2026-11-03", montant: 500 },
    ];
    expect(sansDoublonsImport(l, [{ date: "2026-11-02", montant: 1000 }])).toEqual([
      { date: "2026-11-02", montant: 1000 },
      { date: "2026-11-03", montant: 500 },
    ]);
  });

  it("tolère un décalage de date entre fichier (date d'opération) et banque (date comptable)", () => {
    const l = [{ date: "2026-10-31", montant: -52 }, { date: "2026-10-31", montant: -52 }, { date: "2026-10-20", montant: -52 }];
    expect(sansDoublonsImport(l, [{ date: "2026-10-30", montant: -52 }])).toEqual([{ date: "2026-10-31", montant: -52 }, { date: "2026-10-20", montant: -52 }]);
  });

  it("calcule la date de début et la cadence", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(debutReleve(undefined, now)).toBe("2026-08-07");
    expect(debutReleve("2026-11-04", now)).toBe("2026-10-30");
    expect(debutReleve("2026-01-01", now)).toBe("2026-08-07");
    expect(releveBanqueDu(undefined, now)).toBe(true);
    expect(releveBanqueDu(now - 3600_000, now)).toBe(false);
    expect(releveBanqueDu(now - 9 * 3600_000, now)).toBe(true);
    expect(joursRestants("2026-11-20T12:00:00Z", now)).toBe(15);
  });

  it("met la Caisse d'Épargne Île-de-France en premier", () => {
    const l = trierBanques([{ name: "BNP Paribas" }, { name: "Caisse d'Epargne Normandie" }, { name: "Caisse d'Epargne Ile de France" }]);
    expect(l.map((b) => b.name)).toEqual(["Caisse d'Epargne Ile de France", "Caisse d'Epargne Normandie", "BNP Paribas"]);
  });
});
