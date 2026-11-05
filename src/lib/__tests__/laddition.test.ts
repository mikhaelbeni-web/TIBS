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
