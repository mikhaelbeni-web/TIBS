import { describe, expect, it } from "vitest";
import { inboxDeLaFacture } from "@/lib/factureSource";
import type { InboxDoc } from "@/lib/ingest";

const ligne = (id: string, numero: string, ttc: number, fournisseur = "Halles Paris Sud", statut: InboxDoc["statut"] = "valide") => ({
  id,
  data: { statut, item: { kind: "facture" as const, fournisseur, numero, montantTTC: ttc, source: { messageId: "m" + id, attachment: "f.pdf" } } },
});

describe("inboxDeLaFacture", () => {
  const f = { numero: "FAC-1", montantTTC: 9909, supplierNom: "Halles Paris Sud" };
  it("retrouve le mail au même numéro et montant", () => {
    expect(inboxDeLaFacture(f, [ligne("a", "FAC-2", 9909), ligne("b", "fac 1", 9909)])).toBe("b");
  });
  it("préfère le même montant quand deux fournisseurs ont le même numéro", () => {
    expect(inboxDeLaFacture(f, [ligne("a", "FAC-1", 100, "Autre"), ligne("b", "FAC-1", 9909, "Autre")])).toBe("b");
  });
  it("ignore les lignes rejetées et les numéros vides", () => {
    expect(inboxDeLaFacture(f, [ligne("a", "FAC-1", 9909, "Halles Paris Sud", "rejete")])).toBeNull();
    expect(inboxDeLaFacture({ ...f, numero: " " }, [ligne("a", "", 9909)])).toBeNull();
  });
  it("refuse un numéro seul, sans montant ni fournisseur communs", () => {
    expect(inboxDeLaFacture(f, [ligne("a", "FAC-1", 100, "Autre")])).toBeNull();
  });
});
