import { describe, expect, it } from "vitest";
import { justifierReleve, resumerMois, type LigneJustifiee } from "../justification";
import type { BankTransaction, Invoice, Supplier, WithId } from "../types";

// Libellés au format du relevé Caisse d'Épargne, montants fictifs.
const tx = (id: string, date: string, montant: number, libelle: string): WithId<BankTransaction> => ({ id, date, montant, libelle, importId: "banque", createdAt: 0 });
const sup = (id: string, nom: string, extra: Partial<Supplier> = {}): WithId<Supplier> => ({ id, nom, createdAt: 0, ...extra });
const fac = (id: string, supplierId: string, supplierNom: string, dateFacture: string, ttc: number): WithId<Invoice> => ({
  id, supplierId, supplierNom, numero: `N${id}`, dateFacture, mois: dateFacture.slice(0, 7), montantHT: 0, montantTVA: 0, montantTTC: ttc, statut: "a_payer", createdAt: 0,
});

const bank = [
  // Remises CB du mardi 03/11 pour la journée du lundi 02/11 (1 000 € en caisse).
  tx("cb1", "2026-11-03", 60000, "CB TIB S 021126 CONTRAT 8060564 REM 123456"),
  tx("cb2", "2026-11-03", 40000, "CB TIB S 021126 CONTRAT 8060565 REM 123457"),
  tx("com", "2026-11-03", -450, "*CB COM TIB S 021126 CONTRAT 8060564 REM 123456"),
  // Remise CB du 05/11 : 200 € pour 500 € en caisse (écart au-delà des tickets-resto : non expliqué).
  tx("cb3", "2026-11-05", 20000, "CB TIB S 041126 CONTRAT 8060564 REM 123458"),
  tx("uber", "2026-11-04", 81234, "VIR SEPA STICHTING CUSTODIAN UB"),
  tx("tr", "2026-11-06", 12345, "VIR SEPA EDENRED FRANCE"),
  tx("metro", "2026-11-07", -25000, "PRLV METRO FRANCE S.A.S.-METRO F 2621822G10508585"),
  tx("metro2", "2026-11-09", -9999, "PRLV METRO FRANCE S.A.S.-METRO F 2621822G10508586"),
  tx("urssaf", "2026-11-05", -150000, "PRLV URSSAF ILE DE FRANCE 123456789"),
  tx("salaire", "2026-11-02", -120000, "VIR SEPA DUPONT JEAN Virement vers DUPONT JEAN"),
  tx("remise", "2026-11-16", -50000, "REM VIR SEPA DU 16/11/26 200630742026-11-10-16.13.38.3470"),
  tx("mystere", "2026-11-10", -77700, "VIR SEPA EVA INVEST Virement vers EVA INVEST"),
  tx("carte", "2026-11-11", -4250, "CB CARREFOUR 1011"),
];
const suppliers = [sup("metro", "Metro", { paiement: "prelevement" }), sup("a", "Fournisseur A"), sup("b", "Fournisseur B"), sup("c", "Boulangerie C")];
const invoices = [
  fac("m1", "metro", "Metro", "2026-11-06", 25000),
  fac("a1", "a", "Fournisseur A", "2026-10-05", 20000),
  fac("b1", "b", "Fournisseur B", "2026-10-12", 30000),
  fac("c1", "c", "Boulangerie C", "2026-11-11", 4250),
];
const cash = [
  { id: "2026-11-02", date: "2026-11-02", cb: 100000, uber: 50000 },
  { id: "2026-11-04", date: "2026-11-04", cb: 50000 },
];
const r = justifierReleve({
  today: "2026-11-19",
  bank,
  invoices,
  suppliers,
  cash,
  versementsUber: [{ id: "u1", date: "2026-11-03", montant: 81234, brut: 110000, debut: "2026-10-26", fin: "2026-11-01" }],
  employes: [{ nom: "Dupont", prenom: "Jean" }],
});
const ligne = (id: string): LigneJustifiee => r.lignes.find((l) => l.id === id)!;

describe("justifierReleve", () => {
  it("donne une justification à chaque ligne du relevé", () => {
    expect(r.lignes.map((l) => l.id).sort()).toEqual(bank.map((b) => b.id).sort());
    for (const l of r.lignes) expect(l.texte.length).toBeGreaterThan(10);
  });

  it("remises CB : justifiées par la journée de caisse, écart non expliqué à regarder", () => {
    expect(ligne("cb1")).toMatchObject({ nature: "Remise CB", statut: "justifie", cb: "2026-11-03", lien: "/rapprochement?jour=2026-11-02" });
    expect(ligne("cb2").statut).toBe("justifie");
    expect(r.groupesCB["2026-11-03"]).toMatchObject({ remises: 2, banque: 100000, caisse: 100000, ecart: 0 });
    expect(ligne("cb3").statut).toBe("anomalie");
    // Petit manque (≤ 200 €) = tickets-resto passés en CB : justifié.
    const petit = justifierReleve({ today: "2026-11-19", bank: [tx("p", "2026-11-05", 35000, "CB TIB S 041126 CONTRAT 8060564 REM 123458")], invoices: [], suppliers: [], cash: [cash[1]], versementsUber: [] });
    expect(petit.lignes[0].statut).toBe("justifie");
    expect(petit.lignes[0].texte).toContain("tickets-resto");
  });

  it("Uber, titres-restaurant, frais, URSSAF, salaire", () => {
    expect(ligne("uber")).toMatchObject({ nature: "Uber Eats", statut: "justifie" });
    expect(ligne("uber").texte).toContain("26/10");
    expect(ligne("tr")).toMatchObject({ nature: "Titres-restaurant", statut: "justifie" });
    expect(ligne("tr").texte).toContain("Edenred");
    expect(ligne("com")).toMatchObject({ nature: "Frais bancaires", statut: "explique" });
    expect(ligne("urssaf")).toMatchObject({ nature: "Impôts et social", statut: "explique" });
    expect(ligne("salaire")).toMatchObject({ nature: "Salaire", statut: "explique" });
  });

  it("fournisseurs : facture au centime, débit sans facture, remise groupée, montant identique", () => {
    expect(ligne("metro")).toMatchObject({ nature: "Fournisseur", statut: "justifie" });
    expect(ligne("metro").factures?.map((f) => f.id)).toEqual(["m1"]);
    expect(ligne("metro2").statut).toBe("anomalie");
    expect(ligne("remise")).toMatchObject({ nature: "Virements groupés", statut: "justifie" });
    expect(ligne("remise").factures?.map((f) => f.id).sort()).toEqual(["a1", "b1"]);
    expect(ligne("carte")).toMatchObject({ statut: "justifie" });
    expect(ligne("carte").factures?.[0].id).toBe("c1");
    expect(ligne("mystere").statut).toBe("non_justifie");
  });

  it("résumé du mois", () => {
    const m = resumerMois("2026-11", r.lignes);
    expect(m.lignes).toBe(bank.length);
    expect(m.credits).toBe(60000 + 40000 + 20000 + 81234 + 12345);
    expect(Object.values(m.statuts).reduce((a, b) => a + b, 0)).toBe(bank.length);
  });

  it("relevé vide", () => {
    expect(justifierReleve({ today: "2026-11-19", bank: [], invoices, suppliers, cash, versementsUber: [] })).toEqual({ lignes: [], groupesCB: {} });
  });

  it("un mois chargé tient dans un document Firestore", () => {
    const gros = Array.from({ length: 700 }, (_, i) => tx(`g${i}`, `2026-11-${String((i % 28) + 1).padStart(2, "0")}`, -(1000 + i), `PRLV FOURNISSEUR INCONNU NUMERO ${100000 + i} REF ABCDEFGHIJ`));
    const x = justifierReleve({ today: "2026-11-30", bank: gros, invoices: [], suppliers: [], cash: [], versementsUber: [] });
    expect(JSON.stringify(x).length).toBeLessThan(900_000);
  });
});

describe("cas constatés sur le relevé réel (montants fictifs)", () => {
  it("lot crédité un jour plus tard : manque et excédent voisins se compensent", () => {
    const x = justifierReleve({
      today: "2026-08-30",
      bank: [
        tx("a", "2026-08-11", 50000, "CB TIB S 100826 CONTRAT 8060564 REM 123456"),
        tx("b", "2026-08-12", 70000, "CB TIB S 110826 CONTRAT 8060564 REM 123457"),
        tx("c", "2026-08-13", 90000, "CB TIB S 120826 CONTRAT 8060564 REM 123458"),
      ],
      invoices: [], suppliers: [], versementsUber: [],
      cash: [
        { id: "1", date: "2026-08-10", cb: 50000 },
        { id: "2", date: "2026-08-11", cb: 170000 },
        { id: "3", date: "2026-08-12", cb: 0 },
      ].map((c, i) => (i === 2 ? { ...c, cb: 1 } : c)),
    });
    // 12/08 : -1 000 €, 13/08 : +900 € (lot de la veille) → compensés.
    const b = x.lignes.find((l) => l.id === "b")!;
    expect(b.statut).toBe("justifie");
    expect(b.texte).toContain("compensé");
  });

  it("dépôts d'espèces ronds couverts en cumul, Stripe, carte à débit différé, semaine Uber du libellé", () => {
    const x = justifierReleve({
      today: "2026-08-30",
      bank: [
        tx("d", "2026-08-12", 500000, "DPT VRAC ESP 0003529060 120826 N 0003529060"),
        tx("s", "2026-08-10", 22772, "VIR SEPA STRIPE DISHOP"),
        tx("k", "2026-08-04", -630797, "CB 4739******202103 TOT DIF JUIL"),
        tx("u", "2026-08-10", 317760, "VIR SEPA STICHTING CUSTODIAN UB POP SVCS, DOB , 20260803 - 2"),
        tx("m", "2026-08-13", 15800, "VIR SEPA METRO FRANCE /INV/0170-0053-072138 11.8.2026"),
      ],
      invoices: [], suppliers: [], versementsUber: [],
      cash: Array.from({ length: 10 }, (_, i) => ({ id: `j${i}`, date: `2026-08-0${i}`.replace("-0010", "-10"), cb: 0, especes: 60000, uber: 50000 })).slice(1),
    });
    const l = (id: string) => x.lignes.find((y) => y.id === id)!;
    expect(l("d").statut).toBe("justifie");
    expect(l("s").nature).toBe("Ventes en ligne");
    expect(l("k").nature).toBe("Carte bancaire");
    expect(l("u").texte).toContain("semaine du 03/08/2026 au 09/08/2026");
    expect(l("m").nature).toBe("Remboursement");
  });
});
