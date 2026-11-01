import { describe, expect, it } from "vitest";
import { controlerPrelevement, echeanceVirement, grouperParFournisseur, motsBanque, referenceVirement } from "../paiements";
import type { BankTransaction, Invoice, Supplier, WithId } from "../types";

const inv = (id: string, supplierId: string, ttc: number, statut: Invoice["statut"] = "a_payer"): WithId<Invoice> => ({
  id,
  supplierId,
  supplierNom: supplierId.toUpperCase(),
  numero: `F-${id}`,
  dateFacture: "2026-10-05",
  mois: "2026-10",
  montantHT: ttc,
  montantTVA: 0,
  montantTTC: ttc,
  statut,
  createdAt: 0,
});
const sup = (id: string, nom: string, extra: Partial<Supplier> = {}): WithId<Supplier> => ({ id, nom, createdAt: 0, ...extra });
const tx = (id: string, date: string, montant: number, libelle: string): WithId<BankTransaction> => ({ id, date, montant, libelle, importId: "i", createdAt: 0 });

describe("paiements fournisseurs", () => {
  it("regroupe par fournisseur avec total et reste à payer", () => {
    const g = grouperParFournisseur(
      [inv("1", "hps", 10000), inv("2", "hps", 5000, "payee"), inv("3", "metro", 2000), inv("4", "old", 700)],
      [sup("hps", "Halles Paris Sud"), sup("metro", "METRO", { paiement: "prelevement" })],
    );
    expect(g.map((x) => [x.nom, x.mode, x.total, x.reste])).toEqual([
      ["Halles Paris Sud", "virement", 15000, 10000],
      ["METRO", "prelevement", 2000, 2000],
      ["OLD", "virement", 700, 700],
    ]);
  });

  it("trouve les mots du libellé bancaire", () => {
    expect(motsBanque("SAS PREMIUM DISTRIB")).toEqual(["PREMIUM DISTRIB"]);
    expect(motsBanque("Metro", "metro, makro")).toEqual(["METRO", "MAKRO"]);
  });

  it("contrôle un prélèvement sur le mois et le mois suivant", () => {
    const banque = [
      tx("a", "2026-10-20", -1500, "PRLV SEPA METRO FRANCE"),
      tx("b", "2026-11-03", -500, "PRLV METRO"),
      tx("c", "2026-12-02", -999, "PRLV METRO"), // hors fenêtre
      tx("d", "2026-10-21", 5000, "VIR METRO"), // crédit
    ];
    const g = { nom: "METRO", total: 2000 };
    expect(controlerPrelevement(g, "2026-10", banque)).toMatchObject({ preleve: 2000, ecart: 0, etat: "ok" });
    expect(controlerPrelevement({ ...g, total: 3000 }, "2026-10", banque).etat).toBe("ecart");
    expect(controlerPrelevement({ nom: "Brake", total: 100 }, "2026-10", banque).etat).toBe("absent");
  });

  it("prépare la référence du virement", () => {
    expect(referenceVirement("2026-10", [{ numero: "A1", statut: "a_payer" }, { numero: "A2", statut: "payee" }])).toBe("Factures 10/2026 A1");
  });

  it("fixe le virement au 15 du mois suivant", () => {
    expect(echeanceVirement("2026-10")).toBe("2026-11-15");
    expect(echeanceVirement("2026-12")).toBe("2027-01-15");
  });
});
