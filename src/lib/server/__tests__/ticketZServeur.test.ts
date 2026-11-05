import { describe, expect, it } from "vitest";
import { entreeDepuisZ, fusionnerZ, journeesDesServices, moisARelever } from "../ticketZServeur";

describe("robot tickets Z", () => {
  it("mois à relever : le précédent aussi les 3 premiers jours", () => {
    expect(moisARelever(new Date("2026-11-02T10:00:00Z"))).toEqual(["2026-10", "2026-11"]);
    expect(moisARelever(new Date("2026-11-05T10:00:00Z"))).toEqual(["2026-11"]);
    expect(moisARelever(new Date("2027-01-01T10:00:00Z"))).toEqual(["2026-12", "2027-01"]);
  });
  it("additionne les services d'un même jour et garde les liens des Z", () => {
    const s = (jour: string, cb: number, url?: string) => ({ jour, caTtcNet: cb, ttc10: cb, ttc20: 0, ttc55: 0, cash: 0, cb, uber: 0, ...(url ? { zUrl: url } : {}) });
    const j = journeesDesServices([s("2026-10-01", 100, "https://data.laddition.com/a"), s("2026-10-01", 50), s("2026-10-02", 70, "https://data.laddition.com/b")]);
    expect(j.get("2026-10-01")).toMatchObject({ cb: 150, liens: ["https://data.laddition.com/a"] });
    expect(j.size).toBe(2);
  });
  it("Z lu → journée de service (clôture après minuit = veille)", () => {
    const { jour, entry } = entreeDepuisZ({
      dateTicket: "2026-11-05",
      heureCloture: "00:53",
      paiements: [
        { libelle: "CB", montant: 150000 },
        { libelle: "Uber Eats", montant: 90100, nombre: 25 },
      ],
      total: 240100,
    });
    expect(jour).toBe("2026-11-04");
    expect(entry).toMatchObject({ cb: 150000, uber: 90100, uberCommandes: 25, total: 240100, source: "ticketZ" });
  });
  it("deux Z la même journée (midi et soir) : paiements et totaux additionnés", () => {
    const midi = { dateTicket: "2026-10-02", heureCloture: "15:05", paiements: [{ libelle: "CB", montant: 50000 }, { libelle: "Uber Eats", montant: 10000, nombre: 4 }], total: 60000, ttc10: 60000 };
    const soir = { dateTicket: "2026-10-03", heureCloture: "00:40", paiements: [{ libelle: "cb ", montant: 70000 }, { libelle: "Uber Eats", montant: 20000, nombre: 6 }, { libelle: "Espèces", montant: 5000 }], total: 95000 };
    const z = fusionnerZ([soir, midi]);
    expect(z).toMatchObject({ dateTicket: "2026-10-03", heureCloture: "00:40", total: 155000, ttc10: 60000 });
    expect(z.paiements).toEqual([
      { libelle: "CB", montant: 120000 },
      { libelle: "Uber Eats", montant: 30000, nombre: 10 },
      { libelle: "Espèces", montant: 5000 },
    ]);
    expect(entreeDepuisZ(z).entry).toMatchObject({ cb: 120000, uber: 30000, uberCommandes: 10, especes: 5000 });
    expect(fusionnerZ([midi])).toBe(midi);
  });
});
