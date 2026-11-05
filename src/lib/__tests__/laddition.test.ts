import { describe, expect, it } from "vitest";
import { bornesMois, chiffresCoherents, extraireChiffres, montantFr, parseMontantFr } from "../laddition";
import { chiffrer, dechiffrer } from "../server/secretBox";
import { urlPourMois, urlSansSecret } from "../server/ladditionBot";

// Chiffres réels d'octobre 2026 (Manin 19e), donnés par le gérant.
const OCTOBRE = { caTtcNet: 20032425, ttc10: 19468025, ttc20: 137200, ttc55: 427200 };

describe("parseMontantFr", () => {
  it("lit les formats français", () => {
    expect(parseMontantFr("200 324,25 €")).toBe(20032425);
    expect(parseMontantFr("200 324,25 €")).toBe(20032425);
    expect(parseMontantFr("1.372,00")).toBe(137200);
    expect(parseMontantFr("1372")).toBe(137200);
    expect(parseMontantFr("4 272,5")).toBe(427250);
    expect(parseMontantFr("-12,30")).toBe(-1230);
    expect(parseMontantFr("—")).toBeNull();
  });
});

describe("extraireChiffres", () => {
  it("libellé et montant sur la même ligne", () => {
    const t = "Comptabilité CA/TVA\nCA TTC net 200 324,25 €\nTTC 10% 194 680,25 €\nTTC 20 % 1 372,00 €\nTTC 5,5% 4 272,00 €";
    expect(extraireChiffres(t)).toEqual(OCTOBRE);
  });

  it("tableau : en-têtes puis valeurs, séparés par des tabulations", () => {
    const t = "Période du 01/10/2026 au 31/10/2026\nCA TTC net\tTTC 5,5 %\tTTC 10 %\tTTC 20 %\n200 324,25 €\t4 272,00 €\t194 680,25 €\t1 372,00 €";
    expect(extraireChiffres(t)).toEqual(OCTOBRE);
  });

  it("libellé au-dessus du chiffre (cartes)", () => {
    const t = "CA TTC net\n200 324,25 €\nTTC 10,00 %\n194 680,25 €\nTTC 20,00 %\n1 372,00 €\nTTC 5,50 %\n4 272,00 €";
    expect(extraireChiffres(t)).toEqual(OCTOBRE);
  });

  it("chiffre absent : null", () => {
    expect(extraireChiffres("CA TTC net 10,00").ttc20).toBeNull();
  });
});

describe("chiffresCoherents", () => {
  it("octobre 2026 : 10 % + 20 % + 5,5 % = CA TTC net", () => {
    expect(chiffresCoherents(OCTOBRE)).toBe(true);
    expect(chiffresCoherents({ ...OCTOBRE, ttc20: 0 })).toBe(false);
  });
});

describe("mois", () => {
  it("bornes", () => {
    expect(bornesMois("2026-10")).toEqual({ debut: "2026-10-01", fin: "2026-10-31" });
    expect(bornesMois("2028-02")).toEqual({ debut: "2028-02-01", fin: "2028-02-29" });
  });
  it("format comptable", () => {
    expect(montantFr(20032425).replace(/\s/g, " ")).toBe("200 324,25");
  });
});

describe("robot : URL", () => {
  it("réécrit les dates ISO ou françaises de l'URL", () => {
    expect(urlPourMois("https://x/v2/accounting?start=2026-11-01&end=2026-11-05", "2026-10")).toBe(
      "https://x/v2/accounting?start=2026-10-01&end=2026-10-31",
    );
    expect(urlPourMois("https://x/a?from=01%2F11%2F2026&to=05%2F11%2F2026", "2026-10")).toBe("https://x/a?from=01%2F10%2F2026&to=31%2F10%2F2026");
    expect(urlPourMois("https://x/v2/shift-details", "2026-10")).toBeNull();
  });
  it("masque les jetons dans le diagnostic", () => {
    expect(urlSansSecret("https://x/api?token=abc&date=1")).toBe("https://x/api?token=%E2%80%A6&date=1");
  });
});

describe("secretBox", () => {
  it("chiffre et déchiffre ; une autre clé échoue", () => {
    const box = chiffrer("mot de passe é", "clé-1");
    expect(box.data).not.toContain("mot");
    expect(dechiffrer(box, "clé-1")).toBe("mot de passe é");
    expect(() => dechiffrer(box, "clé-2")).toThrow();
  });
});

describe("robot : mois affiché", () => {
  it("strict : premier et dernier jour du mois", async () => {
    const { moisAffiche } = await import("../server/ladditionBot");
    expect(moisAffiche("Du 01/10/2026 au 31/10/2026", "2026-10", true)).toBe(true);
    expect(moisAffiche("https://x/v2/shift-details?start=2026-10-01&end=2026-10-31", "2026-10", true)).toBe(true);
    expect(moisAffiche("01/10/26 - 31/10/26", "2026-10", true)).toBe(true);
    expect(moisAffiche("du 6 octobre 2026 au 5 novembre 2026", "2026-10", true)).toBe(false);
    expect(moisAffiche("Du 06/10/2026 au 31/10/2026", "2026-10", true)).toBe(false);
    expect(moisAffiche("octobre 2026", "2026-10")).toBe(true);
  });
});

describe("tableau « CA/TVA par famille » (reporting-pos /vat-family)", () => {
  // Mise en page relevée sur le vrai site le 05/11/2026 ; montants d'octobre répartis sur deux familles.
  const entete = "CA/TVA par famille\nPlage de dates 01 oct. 2026 - 31 oct. 2026\nGrouper par Types de produit | TVA\nDétail par service\nExporter en XLS\n";
  const colonnes = ["CA TTC", "CA HT*", "TVA", "Remises", "Offerts", "CA TTC Brut"];

  it("lignes séparées par des tabulations : Total + somme par taux", async () => {
    const { extraireChiffres, extraireTableauTva } = await import("../laddition");
    const t =
      entete +
      ["", ...colonnes].join("\t") + "\n" +
      "Total\t200324.25\t182175.41\t18148.84\t543.05\t4.00\t200871.30\n" +
      "Plats\t160000.00\t145454.55\t14545.45\t400.00\t0.00\t160400.00\n" +
      "10%\t157000.00\t142727.27\t14272.73\t400.00\t0.00\t157400.00\n" +
      "5.5%\t3000.00\t2843.60\t156.40\t0.00\t0.00\t3000.00\n" +
      "Boissons\t40324.25\t36720.86\t3603.39\t143.05\t4.00\t40471.30\n" +
      "10%\t37680.25\t34254.77\t3425.48\t143.05\t4.00\t37827.30\n" +
      "20%\t1372.00\t1143.33\t228.67\t0.00\t0.00\t1372.00\n" +
      "5.5%\t1272.00\t1205.69\t66.31\t0.00\t0.00\t1272.00\n" +
      "0%\t0.00\t0.00\t0.00\t0.00\t0.00\t0.00";
    expect(extraireTableauTva(t)).toEqual(OCTOBRE);
    expect(extraireChiffres(t)).toEqual(OCTOBRE);
  });

  it("une cellule par ligne (tableau en div)", async () => {
    const { extraireTableauTva } = await import("../laddition");
    // Comme sur le vrai site : « TOTAL DU HT » (mode de calcul) avant les colonnes, pagination après le tableau.
    const t =
      entete.replace("Exporter en XLS", "Mode de calcul du CA HT*\nTOTAL DU HT\nA PARTIR DU TTC\nExporter en XLS") +
      colonnes.join("\n") +
      "\nTotal\n200324.25\n182175.41\nToutes\n200324.25\n10%\n194680.25\n1\n20%\n1372.00\n5.5%\n4272.00\n0%\n0.00" +
      "\nLignes par page\n10\n25\n50\n100\n200\n1-37 of 37";
    expect(extraireTableauTva(t)).toEqual(OCTOBRE);
  });

  it("autre page : null (on garde la lecture par libellés)", async () => {
    const { extraireTableauTva } = await import("../laddition");
    expect(extraireTableauTva("CA TTC net 200 324,25 €")).toBeNull();
    expect(extraireTableauTva("Dashboard\nComptabilité")).toBeNull();
  });
});

describe("robot : plage de dates en lettres et période des exports", () => {
  it("« 01 oct. 2026 - 31 oct. 2026 »", async () => {
    const { moisAffiche } = await import("../server/ladditionBot");
    expect(moisAffiche("Plage de dates 01 oct. 2026 - 31 oct. 2026", "2026-10", true)).toBe(true);
    expect(moisAffiche("Plage de dates 1er octobre 2026 - 31 octobre 2026", "2026-10", true)).toBe(true);
    expect(moisAffiche("Plage de dates 05 oct. 2026 - 04 nov. 2026", "2026-10", true)).toBe(false);
    expect(moisAffiche("Plage de dates 01 févr. 2028 - 29 févr. 2028", "2028-02", true)).toBe(true);
    expect(moisAffiche("Plage de dates 11 oct. 2026 - 31 oct. 2026", "2026-10", true)).toBe(false);
  });

  it("verifierPeriodeExport", async () => {
    const { verifierPeriodeExport } = await import("../server/ladditionBot");
    const oct = [{ jour: "2026-10-01" }, { jour: "2026-10-31" }];
    const debordant = [...oct, { jour: "2026-11-02" }];
    const defaut = { debut: "2026-10-05", fin: "2026-11-04" };
    const mois = { debut: "2026-10-01", fin: "2026-10-31" };
    // Nom daté du mois : il fait foi.
    expect(verifierPeriodeExport(oct, "2026-10", mois, false, false)).toEqual({ periode: mois });
    // Nom avec la plage par défaut, période imposée, aucun service hors du mois : données du mois.
    expect(verifierPeriodeExport(oct, "2026-10", defaut, false, true)).toEqual({ periode: mois });
    // Nom avec la plage par défaut et des services hors du mois : la plage du nom (incomplète) reste.
    expect(verifierPeriodeExport(debordant, "2026-10", defaut, false, true)).toEqual({ periode: defaut });
    // Sans nom daté : mois confirmé et aucun débordement → mois ; débordement → refus.
    expect(verifierPeriodeExport(oct, "2026-10", null, true, true)).toEqual({ periode: mois });
    expect(verifierPeriodeExport(debordant, "2026-10", null, true, true)).toHaveProperty("note");
    expect(verifierPeriodeExport(oct, "2026-10", null, false, false)).toEqual({ periode: null });
  });
});
