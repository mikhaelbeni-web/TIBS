import { describe, expect, it } from "vitest";
import { coutUsd, DEFAULT_REGLAGES, parseReglages, releveDu } from "../reglages";

describe("réglages", () => {
  it("borne les valeurs saisies et garde les défauts sinon", () => {
    const r = parseReglages({ modele: "inconnu", budgetMensuelUsd: -5, maxLecturesParVerification: 99999, frequenceHeures: 7 });
    expect(r.modele).toBe(DEFAULT_REGLAGES.modele);
    expect(r.budgetMensuelUsd).toBeGreaterThanOrEqual(0);
    expect(r.maxLecturesParVerification).toBeLessThan(99999);
    expect(parseReglages(null)).toEqual(DEFAULT_REGLAGES);
  });

  it("calcule le coût en dollars", () => {
    expect(coutUsd("opus", 1_000_000, 0)).toBeCloseTo(4);
    expect(coutUsd("haiku", 0, 1_000_000)).toBeCloseTo(0.5);
  });

  it("déclenche le relevé selon la fréquence", () => {
    const now = Date.UTC(2026, 10, 1, 12);
    const r = { ...DEFAULT_REGLAGES, frequenceHeures: 6 };
    expect(releveDu(r, undefined, now)).toBe(true);
    expect(releveDu(r, now - 2 * 3600_000, now)).toBe(false);
    expect(releveDu(r, now - 6 * 3600_000, now)).toBe(true);
    expect(releveDu({ ...r, releveAuto: false }, undefined, now)).toBe(false);
  });
});
