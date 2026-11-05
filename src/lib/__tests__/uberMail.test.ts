import { describe, expect, it } from "vitest";
import { versementDuMail, type InboxUber } from "../ingest";

const recap: InboxUber = {
  kind: "uber",
  date: "2026-10-27",
  montant: 478133,
  brut: 780650,
  frais: 184069,
  titres: 14505,
  versementNet: 492638,
  debut: "2026-10-19",
  fin: "2026-10-25",
  reference: "Semaine du 19/10/2026 au 25/10/2026",
  source: { messageId: "m1" },
};

describe("récap Uber du mail → versement", () => {
  it("enregistre un récap complet et cohérent, une clé par semaine", () => {
    const v = versementDuMail(recap);
    expect(v?.id).toBe("mail-2026-10-19");
    expect(v?.payout).toMatchObject({ date: "2026-10-27", montant: 478133, brut: 780650, titres: 14505, debut: "2026-10-19", fin: "2026-10-25", source: "mail" });
  });
  it("laisse « À vérifier » ce qui est incomplet ou incohérent", () => {
    expect(versementDuMail({ ...recap, brut: undefined })).toBeNull();
    expect(versementDuMail({ ...recap, debut: undefined })).toBeNull();
    expect(versementDuMail({ ...recap, date: undefined })).toBeNull();
    // Versement bancaire + titres ≠ versement net : lecture douteuse.
    expect(versementDuMail({ ...recap, versementNet: 500000 })).toBeNull();
    // Ventes inférieures au versement : impossible.
    expect(versementDuMail({ ...recap, brut: 100000 })).toBeNull();
  });
  it("accepte un récap sans ligne « Versement net »", () => {
    expect(versementDuMail({ ...recap, versementNet: undefined })).not.toBeNull();
  });
});
