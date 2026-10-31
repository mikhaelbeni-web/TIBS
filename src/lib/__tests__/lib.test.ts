import { describe, expect, it } from "vitest";
import { reconcile } from "../reconcile";
import { checkDpae, isValidNir } from "../dpae";
import { toCents, toIsoDate } from "../money";
import { rowToBank, rowToEmployee, normalizeHeader } from "../importer";

describe("money", () => {
  it("parse les formats français", () => {
    expect(toCents("1 234,56")).toBe(123456);
    expect(toCents("1.234,56")).toBe(123456);
    expect(toCents("-12,5 €")).toBe(-1250);
    expect(toCents(12.34)).toBe(1234);
    expect(toCents("abc")).toBeNull();
  });
  it("normalise les dates", () => {
    expect(toIsoDate("31/10/2026")).toBe("2026-10-31");
    expect(toIsoDate("1/2/26")).toBe("2026-02-01");
    expect(toIsoDate("2026-10-31T10:00")).toBe("2026-10-31");
    expect(toIsoDate(46326)).toBe("2026-10-31");
  });
});

describe("NIR", () => {
  it("valide la clé", () => {
    // 1 85 05 78 006 084, clé = 97 - (1850578006084 mod 97)
    const body = "1850578006084";
    let mod = 0;
    for (const c of body) mod = (mod * 10 + Number(c)) % 97;
    const key = String(97 - mod).padStart(2, "0");
    expect(isValidNir(body + key)).toBe(true);
    expect(isValidNir(body + (key === "01" ? "02" : "01"))).toBe(false);
    expect(isValidNir("123")).toBe(false);
  });
  it("gère la Corse", () => {
    const body = "2850520006084"; // 2A -> 19
    const num = "28505" + "19" + "006084";
    let mod = 0;
    for (const c of num) mod = (mod * 10 + Number(c)) % 97;
    const key = String(97 - mod).padStart(2, "0");
    expect(isValidNir("285052A006084" + key)).toBe(true);
    expect(body).toHaveLength(13);
  });
});

describe("DPAE", () => {
  it("signale les champs manquants et le CDD sans fin", () => {
    const r = checkDpae({ nom: "X", typeContrat: "CDD" }, "2026-10-31");
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("Date de fin obligatoire pour un CDD");
    expect(r.errors).toContain("Prénom manquant");
  });
  it("signale le retard", () => {
    const r = checkDpae({ dateEmbauche: "2026-10-01", dpaeStatut: "a_declarer" }, "2026-10-31");
    expect(r.errors.some((e) => e.includes("retard"))).toBe(true);
  });
});

describe("importer", () => {
  it("lit une ligne salarié avec des en-têtes variés", () => {
    const row = Object.fromEntries(
      Object.entries({
        Nom: "dupont",
        Prénom: "Léa",
        Sexe: "F",
        "Date de naissance": "02/03/1995",
        "Date d'embauche": "15/11/2026",
        Contrat: "cdd",
        Poste: "Serveuse",
      }).map(([k, v]) => [normalizeHeader(k), v]),
    );
    const e = rowToEmployee(row);
    expect(e).toMatchObject({ nom: "DUPONT", prenom: "Léa", sexe: "F", dateNaissance: "1995-03-02", typeContrat: "CDD" });
  });
  it("lit débit/crédit séparés", () => {
    expect(rowToBank({ date: "02/10/2026", libelle: "REMISE CB", credit: "1 000,00", debit: "" })).toEqual({
      date: "2026-10-02",
      libelle: "REMISE CB",
      montant: 100000,
    });
    expect(rowToBank({ date: "02/10/2026", libelle: "X", debit: "50,00" })?.montant).toBe(-5000);
    expect(rowToBank({ date: "", montant: "1" })).toBeNull();
  });
});

describe("reconcile", () => {
  it("associe les remises CB avec commission et délai", () => {
    const cash = [
      { id: "z1", date: "2026-10-01", amount: 100000 },
      { id: "z2", date: "2026-10-02", amount: 80000 },
      { id: "z3", date: "2026-10-03", amount: 50000 },
    ];
    const bank = [
      { id: "b1", date: "2026-10-02", amount: 99300, libelle: "REMISE CB" },
      { id: "b2", date: "2026-10-03", amount: 79440, libelle: "REMISE CB" },
      { id: "b3", date: "2026-10-04", amount: 12000, libelle: "AUTRE" },
    ];
    const r = reconcile(cash, bank);
    expect(r.matches.map((m) => [m.cash.id, m.bank.id])).toEqual([
      ["z1", "b1"],
      ["z2", "b2"],
    ]);
    expect(r.matches[0].ecart).toBe(-700);
    expect(r.unmatchedCash.map((c) => c.id)).toEqual(["z3"]);
    expect(r.unmatchedBank.map((b) => b.id)).toEqual(["b3"]);
  });
  it("refuse un crédit antérieur au Z ou supérieur au montant", () => {
    const r = reconcile(
      [{ id: "z", date: "2026-10-05", amount: 1000 }],
      [
        { id: "avant", date: "2026-10-04", amount: 1000, libelle: "" },
        { id: "trop", date: "2026-10-06", amount: 1100, libelle: "" },
      ],
    );
    expect(r.matches).toHaveLength(0);
  });
  it("préfère la paire la plus proche", () => {
    const r = reconcile(
      [
        { id: "a", date: "2026-10-01", amount: 10000 },
        { id: "b", date: "2026-10-01", amount: 9900 },
      ],
      [
        { id: "x", date: "2026-10-02", amount: 9890, libelle: "" },
        { id: "y", date: "2026-10-02", amount: 9990, libelle: "" },
      ],
    );
    expect(r.matches.map((m) => [m.cash.id, m.bank.id]).sort()).toEqual([
      ["a", "y"],
      ["b", "x"],
    ]);
  });
});

import { reconcileDeposits } from "../reconcile";

describe("reconcileDeposits", () => {
  it("regroupe plusieurs jours d'espèces dans un dépôt", () => {
    const days = [
      { id: "d1", date: "2026-10-01", amount: 20000 },
      { id: "d2", date: "2026-10-02", amount: 15000 },
      { id: "d3", date: "2026-10-03", amount: 5000 },
      { id: "d4", date: "2026-10-04", amount: 7000 },
    ];
    const deps = [
      { id: "dep1", date: "2026-10-03", amount: 35000, libelle: "VERSEMENT ESPECES" },
      { id: "dep2", date: "2026-10-09", amount: 9999, libelle: "VERSEMENT ESPECES" },
    ];
    const r = reconcileDeposits(days, deps);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].days.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(r.unmatchedDeposits.map((d) => d.id)).toEqual(["dep2"]);
    expect(r.unmatchedDays.map((d) => d.id)).toEqual(["d3", "d4"]);
  });
});

import { bankDocId, isCashDeposit, rowsToCash } from "../cashImport";

describe("cashImport", () => {
  it("additionne les lignes d'un même jour", () => {
    const r = rowsToCash([
      { date: "01/10/2026", cb: "100,00", especes: "20" },
      { date: "01/10/2026", cb: "50,50" },
      { date: "02/10/2026", tr: "12" },
    ]);
    expect(r).toEqual([
      { date: "2026-10-01", cb: 15050, especes: 2000, ticketsResto: 0, autres: 0, ttc55: 0, ttc10: 0, ttc20: 0 },
      { date: "2026-10-02", cb: 0, especes: 0, ticketsResto: 1200, autres: 0, ttc55: 0, ttc10: 0, ttc20: 0 },
    ]);
  });
  it("reconnaît les dépôts d'espèces et produit des ids stables", () => {
    expect(isCashDeposit("VERSEMENT ESPECES AG 123")).toBe(true);
    expect(isCashDeposit("REMISE CB 4567")).toBe(false);
    expect(bankDocId("2026-10-01", 1000, "Remise CB / 123", 0)).toBe("2026-10-01_1000_remisecb123_0");
  });
});

import { tvaFromTtc, tvaReport } from "../tva";

describe("TVA", () => {
  it("calcule la TVA incluse", () => {
    expect(tvaFromTtc(11000, 0.1)).toBe(1000);
    expect(tvaFromTtc(12000, 0.2)).toBe(2000);
    expect(tvaFromTtc(10550, 0.055)).toBe(550);
  });
  it("collectée - déductible sur la période, signale les jours non ventilés", () => {
    const base = { cb: 0, especes: 0, ticketsResto: 0, autres: 0, createdAt: 0 };
    const cash = [
      { ...base, date: "2026-10-01", cb: 13200, ttc10: 11000, ttc20: 2200 },
      { ...base, date: "2026-10-02", cb: 5000 },
      { ...base, date: "2026-11-01", ttc10: 99999 },
    ];
    const inv = [
      { supplierId: "s", supplierNom: "S", numero: "1", dateFacture: "2026-10-10", mois: "2026-10", montantHT: 1000, montantTVA: 200, montantTTC: 1200, statut: "a_payer" as const, createdAt: 0 },
    ];
    const r = tvaReport(cash, inv, "2026-10-01", "2026-10-31");
    expect(r.totalCollectee).toBe(1000 + 367);
    expect(r.deductible).toBe(200);
    expect(r.net).toBe(1167);
    expect(r.nonVentile).toEqual({ jours: ["2026-10-02"], montant: 5000 });
  });
});

import { echeanceDuMois, prochaineEcheanceTva } from "../tva";

describe("échéance TVA (le 10)", () => {
  it("avant ou le 10 : mois précédent, échéance ce mois-ci", () => {
    expect(prochaineEcheanceTva("2026-11-03")).toEqual({ mois: "2026-10", date: "2026-11-10", joursRestants: 7 });
    expect(prochaineEcheanceTva("2026-11-10")).toEqual({ mois: "2026-10", date: "2026-11-10", joursRestants: 0 });
  });
  it("après le 10 : mois en cours, échéance le mois suivant (passage d'année)", () => {
    expect(prochaineEcheanceTva("2026-10-31")).toEqual({ mois: "2026-10", date: "2026-11-10", joursRestants: 10 });
    expect(prochaineEcheanceTva("2026-12-15")).toEqual({ mois: "2026-12", date: "2027-01-10", joursRestants: 26 });
    expect(prochaineEcheanceTva("2027-01-05")).toEqual({ mois: "2026-12", date: "2027-01-10", joursRestants: 5 });
    expect(echeanceDuMois("2026-12")).toBe("2027-01-10");
  });
});

import { isUber, rowToUber } from "../cashImport";

describe("Uber Eats", () => {
  it("lit une ligne de versement", () => {
    expect(rowToUber({ datedeversement: "03/10/2026", montantnet: "1 234,50", fraisuber: "-300,00", reference: "PO-1" })).toEqual({
      date: "2026-10-03",
      montant: 123450,
      frais: 30000,
      reference: "PO-1",
    });
    expect(rowToUber({ date: "x", montant: "1" })).toBeNull();
  });
  it("rapproche un versement avec le virement UBER, même arrivé la veille", () => {
    expect(isUber("VIR SEPA UBER EATS FRANCE")).toBe(true);
    const r = reconcile(
      [{ id: "p1", date: "2026-10-06", amount: 123450 }],
      [
        { id: "b1", date: "2026-10-05", amount: 123450, libelle: "VIR UBER EATS" },
        { id: "b2", date: "2026-10-06", amount: 99999, libelle: "VIR UBER EATS" },
      ],
      { minDays: -2, maxDays: 5, maxFeeRate: 0, tolerance: 1 },
    );
    expect(r.matches.map((m) => m.bank.id)).toEqual(["b1"]);
    expect(r.unmatchedBank.map((b) => b.id)).toEqual(["b2"]);
  });
});
