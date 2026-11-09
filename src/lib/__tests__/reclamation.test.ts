import { describe, expect, it } from "vitest";
import { construireMail } from "../mime";
import { brouillonReclamation, derniereReclamation, emailValide, facturesPourReleve, lignesAReclamer, moisReleve, reprisesPlusRecentes } from "../reclamation";
import { cleEcart, rapprocher, type Releve } from "../releves";

const rel = (extra: Partial<Releve> = {}): Releve => ({
  fournisseur: "Label Délice",
  mois: "2026-10",
  lignes: [
    { numero: "FA77415", date: "2026-10-01", montantTTC: 98596 },
    { numero: "FA77543", date: "2026-10-09", montantTTC: 83556 },
  ],
  totalTTC: 182152,
  coherent: true,
  source: { messageId: "m" },
  createdAt: 0,
  ...extra,
});
const facture = (numero: string, date: string, ttc: number, supplierNom = "Label Delice") => ({
  id: numero,
  supplierId: "x",
  supplierNom,
  numero,
  dateFacture: date,
  mois: date.slice(0, 7),
  montantHT: ttc,
  montantTVA: 0,
  montantTTC: ttc,
  statut: "a_payer" as const,
  createdAt: 0,
});

describe("réclamation des factures manquantes", () => {
  it("garde seulement les lignes jamais reçues et pas justifiées", () => {
    const r = rel({ justifies: {} });
    const rp = rapprocher(r, [facture("FA77415", "2026-10-01", 98596)]);
    expect(lignesAReclamer(rp).map((l) => l.numero)).toEqual(["FA77543"]);
    expect(lignesAReclamer(rp, { [cleEcart("ligne", "FA77543")]: "demandée par téléphone" })).toEqual([]);
  });

  it("cherche les factures du fournisseur autour des dates du relevé, même nom sans accent", () => {
    const f = [facture("A", "2026-09-05", 1), facture("B", "2026-11-05", 1), facture("C", "2026-07-01", 1), facture("D", "2026-10-02", 1, "Autre")];
    expect(facturesPourReleve(rel(), f).map((x) => x.id)).toEqual(["A", "B"]);
  });

  it("mois du relevé : dernière ligne, jamais après la réception (extrait d'exercice avril → mars)", () => {
    expect(moisReleve({ lignes: [{ date: "2026-09-02" }, { date: "2026-09-30" }], periodeFin: "2027-03-31" }, "2026-10-05T14:25:39Z")).toBe("2026-09");
    expect(moisReleve({ lignes: [], periodeFin: "2027-03-31", dateReleve: "2026-10-05" }, "2026-10-05T14:25:39Z")).toBe("2026-10");
  });

  it("brouillon poli avec numéros, dates et montants", () => {
    const d = brouillonReclamation(rel({ numero: "RL-1" }), rel().lignes, { nom: "Le Tib's Manin", adresse: "161 rue Manin, 75019 Paris", societe: "SAS AVA" });
    expect(d.objet).toContain("Factures manquantes (2)");
    expect(d.corps).toContain("Facture n° FA77415 du 01/10/2026");
    expect(d.corps).toContain("virement correspondant");
    expect(d.corps).toContain("SAS AVA");
    const p = brouillonReclamation(rel(), rel().lignes.slice(0, 1), { nom: "T", adresse: "A" }, "prelevement");
    expect(p.objet).toContain("Facture manquante n° FA77415");
    expect(p.corps).toContain("comptabilité");
  });

  it("dernière réclamation par numéro, adresse valide", () => {
    const r = rel({ reclamations: [{ le: 1, a: "x@y.fr", numeros: ["FA-77543"], objet: "o" }] });
    expect(derniereReclamation(r, "FA77543")?.le).toBe(1);
    expect(derniereReclamation(r, "FA77415")).toBeUndefined();
    expect(emailValide("comptabilite@hpsrungis.com")).toBe(true);
    expect(emailValide("a@b.fr, c@d.fr")).toBe(false);
  });

  it("mail MIME UTF-8, objet encodé, en réponse au relevé", () => {
    const raw = construireMail({ de: '"Le Tib\'s" <a@b.fr>', a: "c@d.fr", objet: "Facture manquante – n° 1", corps: "Bonjour,\nMerci", enReponseA: "<id@x>" });
    const txt = Buffer.from(raw, "base64url").toString("utf8");
    expect(txt).toContain("Subject: =?UTF-8?B?");
    expect(txt).toContain("In-Reply-To: <id@x>");
    const corps = txt.split("\r\n\r\n")[1].replace(/\r\n/g, "");
    expect(Buffer.from(corps, "base64").toString("utf8")).toBe("Bonjour,\r\nMerci");
  });

  it("une facture reprise sur un relevé plus récent n'est comptée que sur le plus récent ; montant nul ignoré", () => {
    const ancien = { id: "a", ...rel({ source: { messageId: "1", receivedAt: "2026-09-01" } }) };
    const recent = { id: "b", ...rel({ lignes: [{ numero: "FA77543", montantTTC: 83556 }, { numero: "Z9", montantTTC: 0 }], source: { messageId: "2", receivedAt: "2026-10-01" } }) };
    const rep = reprisesPlusRecentes([ancien, recent]);
    expect(lignesAReclamer(rapprocher(ancien, []), {}, rep.get("a")).map((l) => l.numero)).toEqual(["FA77415"]);
    expect(lignesAReclamer(rapprocher(recent, []), {}, rep.get("b")).map((l) => l.numero)).toEqual(["FA77543"]);
  });

  it("une facture datée d'avant 2026 n'est pas réclamée", () => {
    const r = rel({ lignes: [{ numero: "F1", date: "2025-12-15", montantTTC: 100 }, { numero: "F2", date: "2026-01-02", montantTTC: 100 }] });
    expect(lignesAReclamer(rapprocher(r, [])).map((l) => l.numero)).toEqual(["F2"]);
  });
});
