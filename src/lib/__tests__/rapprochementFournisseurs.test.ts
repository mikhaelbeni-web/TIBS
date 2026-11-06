import { describe, expect, it } from "vitest";
import { debitDuFournisseur, lireDebit, rapprocher, sommeExacte } from "../rapprochementFournisseurs";
import type { BankTransaction, Invoice, Supplier, WithId } from "../types";

// Libellés réels du relevé (Caisse d'Épargne), montants fictifs.
const tx = (id: string, date: string, montant: number, libelle: string): WithId<BankTransaction> => ({ id, date, montant, libelle, importId: "banque", createdAt: 0 });
const sup = (id: string, nom: string, extra: Partial<Supplier> = {}): WithId<Supplier> => ({ id, nom, createdAt: 0, ...extra });
const fac = (id: string, supplierId: string, supplierNom: string, dateFacture: string, ttc: number, statut: Invoice["statut"] = "a_payer"): WithId<Invoice> => ({
  id, supplierId, supplierNom, numero: id, dateFacture, mois: dateFacture.slice(0, 7), montantHT: 0, montantTVA: 0, montantTTC: ttc, statut, createdAt: 0,
});

describe("lireDebit", () => {
  it("reconnaît les natures et le bénéficiaire", () => {
    expect(lireDebit(tx("a", "2026-08-07", -100, "PRLV METRO FRANCE S.A.S.-METRO F 2621822G10508585"))).toMatchObject({ type: "prelevement", tiers: "METRO FRANCE", montant: 100 });
    expect(lireDebit(tx("b", "2026-08-18", -100, "LCR 925444 RLV 00000088 LPB"))).toMatchObject({ type: "prelevement", tiers: "LPB" });
    expect(lireDebit(tx("c", "2026-09-16", -100, "VIR SEPA HPS Virement vers HPS"))).toMatchObject({ type: "virement", tiers: "HPS" });
    expect(lireDebit(tx("d", "2026-09-21", -100, "VIR INST HPS 2626322I10039805 26263N"))).toMatchObject({ type: "virement", tiers: "HPS" });
    expect(lireDebit(tx("e", "2026-09-16", -100, "REM VIR SEPA DU 16/09/26 200630742026-09-10-16.13.38.3470")).type).toBe("remise");
    expect(lireDebit(tx("f", "2026-09-16", -100, "*CB COM TIB S 123456 CONTRAT 8060564 REM 012345")).type).toBe("frais");
    expect(lireDebit(tx("g", "2026-09-10", -100, "CHEQUE N 0000371 DATE DE REGLEMENT : 10/09/26")).type).toBe("cheque");
  });
});

describe("debitDuFournisseur", () => {
  const d = (l: string) => lireDebit(tx("x", "2026-09-16", -100, l));
  it("par un mot du nom, le début du domaine de l'e-mail, ou le réglage du libellé", () => {
    expect(debitDuFournisseur(d("VIR SEPA HPS Virement vers HPS"), sup("1", "Halles Paris Sud", { email: "comptabilite@hpsrungis.com" }))).toBe(true);
    expect(debitDuFournisseur(d("VIR SEPA YARDEN NOUVEAU Virement vers YARDEN NOUVEAU"), sup("1", "Yarden France"))).toBe(true);
    expect(debitDuFournisseur(d("VIR SEPA OLIV SCOOTER Virement vers OLIV SCOOTER"), sup("1", "Oliv'Scooter"))).toBe(true);
    expect(debitDuFournisseur(d("LCR 925444 RLV 00000088 LPB"), sup("1", "lpbfrance", { email: "noreply@lpbfrance.fr" }))).toBe(true);
    expect(debitDuFournisseur(d("PRLV METRO FRANCE S.A.S.-METRO F 26218"), sup("1", "Yarden France"))).toBe(false);
    expect(debitDuFournisseur(d("PRLV ANETT NORD PICA 1234567G"), sup("1", "Blanchisserie", { libelleBanque: "ANETT" }))).toBe(true);
    // Messagerie grand public : le domaine ne compte pas.
    expect(debitDuFournisseur(d("VIR INST ORANGE 1234567I"), sup("1", "Martin", { email: "x@orange.fr" }))).toBe(false);
  });
});

describe("sommeExacte", () => {
  it("trouve la combinaison au centime", () => {
    expect(sommeExacte([1000, 2550, 333, 4000], 3883)).toEqual([0, 1, 2]);
    expect(sommeExacte([1000, 2550], 3551)).toBeNull();
  });
});

describe("rapprocher", () => {
  const suppliers = [
    sup("hps", "Halles Paris Sud", { email: "comptabilite@hpsrungis.com" }),
    sup("oliv", "Oliv'Scooter"),
    sup("lpb", "lpbfrance", { email: "noreply@lpbfrance.fr" }),
    sup("a", "Fournisseur A"),
    sup("b", "Fournisseur B"),
  ];
  const invoices = [
    // Oliv'Scooter : trois factures de septembre payées d'un seul virement en novembre.
    fac("o1", "oliv", "Oliv'Scooter", "2026-09-07", 2450),
    fac("o2", "oliv", "Oliv'Scooter", "2026-09-10", 1800),
    fac("o3", "oliv", "Oliv'Scooter", "2026-09-11", 7264),
    // LPB : une LCR par facture.
    fac("l1", "lpb", "lpbfrance", "2026-09-30", 62119),
    // A et B : réglés dans la remise groupée du 16/09 avec HPS d'août.
    fac("a1", "a", "Fournisseur A", "2026-08-05", 100000),
    fac("a2", "a", "Fournisseur A", "2026-08-20", 50000),
    fac("b1", "b", "Fournisseur B", "2026-08-12", 33333),
    // B de juillet : jamais vu au relevé.
    fac("b0", "b", "Fournisseur B", "2026-07-10", 9999),
  ];
  const banque = [
    tx("t0", "2026-07-01", 500000, "REMISE CB"),
    tx("t1", "2026-11-05", -11514, "VIR SEPA OLIV SCOOTER Virement vers OLIV SCOOTER"),
    tx("t2", "2026-10-16", -62119, "LCR 971436 RLV 00000092 LPB"),
    tx("t3", "2026-09-16", -183333, "REM VIR SEPA DU 16/09/26 200630742026-09-10-16.13.38.3470"),
    tx("t4", "2026-08-18", -84035, "LCR 925444 RLV 00000088 LPB"),
    tx("t5", "2026-09-16", -1534157, "VIR SEPA HPS Virement vers HPS"),
    tx("t6", "2026-08-07", -187164, "PRLV METRO FRANCE S.A.S.-METRO F 2621822G10508585"),
    tx("t7", "2026-08-14", -187164, "PRLV METRO FRANCE S.A.S.-METRO F 2622422G10213798"),
    tx("t8", "2026-09-10", -30849, "PRLV URSSAF D ILE DE FRANCE 1234567G"),
  ];
  const r = rapprocher(suppliers, invoices, banque, { depuis: "2026-01", aujourdhui: "2026-11-06" });
  const b = (cle: string) => r.fournisseurs.find((x) => x.cle === cle)!;
  const etat = (cle: string, m: string) => b(cle).mois.find((l) => l.mois === m)?.etat;

  it("un virement = le total d'un mois", () => {
    expect(etat("oliv", "2026-09")).toBe("paye");
    expect(b("oliv").modeConstate).toBe("virement");
  });
  it("une LCR = une facture ; une LCR sans facture = facture manquante", () => {
    expect(etat("lpb", "2026-09")).toBe("paye");
    expect(b("lpb").modeConstate).toBe("prelevement");
    expect(b("lpb").totalSansFacture).toBe(84035);
    expect(etat("lpb", "2026-08")).toBe("manquantes");
  });
  it("virement HPS sans aucune facture d'août : factures manquantes", () => {
    expect(b("hps").totalSansFacture).toBe(1534157);
    expect(etat("hps", "2026-08")).toBe("manquantes");
  });
  it("remise groupée composée au centime par les totaux mensuels", () => {
    const remise = r.remises.find((x) => x.debit.id === "t3")!;
    expect(remise.groupes?.map((g) => `${g.cle}:${g.mois}`).sort()).toEqual(["a:2026-08", "b:2026-08"]);
    expect(etat("a", "2026-08")).toBe("paye");
    expect(etat("b", "2026-08")).toBe("paye");
    expect(etat("b", "2026-07")).toBe("non_vu");
  });
  it("prélèvements réguliers sans fiche : listés, impôts et social exclus", () => {
    expect(r.sansFournisseur.map((t) => t.tiers)).toEqual(["METRO FRANCE"]);
    expect(r.sansFournisseur[0]).toMatchObject({ nombre: 2, total: 374328 });
  });
  it("factures à marquer payées", () => {
    expect(r.aPointer.map((p) => p.factureId).sort()).toEqual(["a1", "a2", "b1", "l1", "o1", "o2", "o3"]);
  });
  it("mois avant le début du relevé : non contrôlable", () => {
    const r2 = rapprocher(suppliers, [fac("x", "a", "Fournisseur A", "2026-03-10", 1000)], banque.slice(1), { depuis: "2026-01", aujourdhui: "2026-11-06" });
    expect(r2.fournisseurs.find((x) => x.cle === "a")!.mois.find((l) => l.mois === "2026-03")?.etat).toBe("sans_banque");
  });
});
