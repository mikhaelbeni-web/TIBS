import { describe, expect, it } from "vitest";
import { fauxExport } from "./fauxExport";
import { chiffresDuMois, lignesXlsx, lireExportServices, periodeDuNom, problemeExport } from "../ladditionExport";

// Octobre 2026 réparti en trois services, plus un service de novembre à ignorer.
const SERVICES: [string, number, number, number, number][] = [
  ["2026-10-01", 11540.35, 11100.35, 104, 336],
  ["2026-10-02", 1265.25, 1223.25, 0, 42],
  ["2026-10-31", 187518.65, 182356.65, 1268, 3894],
];

describe("export « Détails par service »", () => {
  it("octobre complet : mêmes chiffres que Comptabilité CA/TVA", async () => {
    const exp = lireExportServices(await lignesXlsx(await fauxExport(SERVICES)));
    expect(exp.etablissement).toBe("Tib’s 19");
    expect(exp.services).toHaveLength(3);
    expect(exp.services[0]).toMatchObject({ jour: "2026-10-01", caTtcNet: 1154035, cash: 10000, uber: 10000, zUrl: "https://data.laddition.com/z.pdf" });
    const per = periodeDuNom("detail-services-Tib’s 19-2026-10-01-2026-10-31.xlsx");
    const r = chiffresDuMois(exp, "2026-10", per);
    expect(r).toEqual({ chiffres: { caTtcNet: 20032425, ttc10: 19468025, ttc20: 137200, ttc55: 427200 }, nbServices: 3, complet: true });
    expect(exp.total).toEqual(r.chiffres);
    expect(problemeExport(r, "2026-10", per)).toBeNull();
  });

  it("ne garde que les services du mois ; refuse une période incomplète", async () => {
    const exp = lireExportServices(await lignesXlsx(await fauxExport([...SERVICES, ["2026-11-01", 10395.4, 10305.4, 90, 0]])));
    const per = periodeDuNom("detail-services-Tib’s 19-2026-10-05-2026-11-04.xlsx");
    const r = chiffresDuMois(exp, "2026-10", per);
    expect(r.nbServices).toBe(3);
    expect(r.complet).toBe(false);
    expect(problemeExport(r, "2026-10", per)).toMatch(/du 01\/10\/2026 au 31\/10\/2026/);
    expect(problemeExport(chiffresDuMois(exp, "2026-09", per), "2026-09", per)).toMatch(/Aucun service/);
  });

  it("nom de fichier", () => {
    expect(periodeDuNom("detail-services-Tib’s 19-2026-10-01-2026-10-31 (1).xlsx")).toEqual({ debut: "2026-10-01", fin: "2026-10-31" });
    expect(periodeDuNom("export.xlsx")).toBeNull();
  });

  it("autre fichier : erreur claire", () => {
    expect(() => lireExportServices([["Date", "Libellé", "Montant"]])).toThrow(/Détails par service/);
  });
});
