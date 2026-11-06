import { describe, expect, it } from "vitest";
import { apparierImports, centimes, compterValeurs, debutReleve, joursRestants, lignesDuCompte, releveBanqueDu, sansDoublonsImport, trierBanques, versLigne } from "../banque";

describe("banque DSP2", () => {
  it("convertit les montants texte en centimes", () => {
    expect(centimes("123.45")).toBe(12345);
    expect(centimes("10.5")).toBe(1050);
    expect(centimes("7")).toBe(700);
    expect(centimes("-0.99")).toBe(-99);
    expect(centimes("abc")).toBeNull();
  });

  it("signe le montant selon crédit / débit et compose le libellé", () => {
    expect(
      versLigne({ transaction_amount: { amount: "42.10", currency: "EUR" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-11-03", remittance_information: ["PRLV SEPA", " METRO  France "] }),
    ).toEqual({ date: "2026-11-03", libelle: "PRLV SEPA METRO France", montant: -4210, ref: undefined });
    expect(versLigne({ transaction_amount: { amount: "980" }, credit_debit_indicator: "CRDT", value_date: "2026-11-04", debtor: { name: "UBER EATS" }, entry_reference: "X1" })).toEqual({
      date: "2026-11-04",
      libelle: "UBER EATS",
      montant: 98000,
      ref: "X1",
      valeur: "2026-11-04",
    });
  });

  it("garde la date de valeur à côté de la date comptable", () => {
    const l = versLigne({ transaction_amount: { amount: "162.05" }, credit_debit_indicator: "CRDT", booking_date: "2026-10-21", value_date: "2026-10-20", remittance_information: ["CB TIB S 201026"] });
    expect(l).toMatchObject({ date: "2026-10-21", valeur: "2026-10-20" });
  });

  it("retrouve l'opération de l'API d'une ligne importée, la date du libellé départageant deux montants égaux", () => {
    const api = [
      { date: "2026-10-21", montant: 2500, libelle: "CB TIB S 201026 CONTRAT 1", valeur: "2026-10-21" },
      { date: "2026-10-21", montant: 2500, libelle: "CB TIB S 191026 CONTRAT 1", valeur: "2026-10-20" },
      { date: "2026-10-21", montant: 900, libelle: "PRLV X", valeur: "2026-10-21" },
    ];
    const imports = [
      { id: "i1", date: "2026-10-21", montant: 2500, libelle: "CB TIB S 191026" },
      { id: "i2", date: "2026-10-21", montant: 2500, libelle: "CB TIB S 201026" },
      { id: "i3", date: "2026-10-21", montant: 777, libelle: "AUTRE" },
    ];
    const m = apparierImports(api, imports);
    expect(m.get("i1")).toBe(api[1]);
    expect(m.get("i2")).toBe(api[0]);
    expect(m.has("i3")).toBe(false);
  });

  it("compte les remises CB selon leur date de valeur, sans montant", () => {
    expect(
      compterValeurs([
        { date: "2026-10-21", montant: 16205, libelle: "CB TIB S 201026", valeur: "2026-10-20" },
        { date: "2026-10-24", montant: 27750, libelle: "CB TIB S 231026", valeur: "2026-10-26" },
        { date: "2026-10-22", montant: 40000, libelle: "CB TIB S 211026" },
        { date: "2026-10-22", montant: -150, libelle: "CB COM TIB S 211026", valeur: "2026-10-21" },
      ]),
    ).toEqual({ remises: 3, avecValeur: 2, valeurAvant: 1, valeurApres: 1 });
  });

  it("ignore les opérations en attente", () => {
    expect(versLigne({ transaction_amount: { amount: "1" }, status: "PDNG", booking_date: "2026-11-01" })).toBeNull();
  });

  it("donne des identifiants stables, distincts pour deux opérations identiques sans référence", () => {
    const t = { transaction_amount: { amount: "3.50" }, credit_debit_indicator: "DBIT", booking_date: "2026-11-02", remittance_information: ["CAFE"] };
    const a = lignesDuCompte("acc1", [t, t]);
    const b = lignesDuCompte("acc1", [t, t]);
    expect(a.map((l) => l.id)).toEqual(b.map((l) => l.id));
    expect(a[0].id).not.toBe(a[1].id);
    expect(a[0].id.startsWith("eb_2026-11-02_")).toBe(true);
    expect(lignesDuCompte("acc2", [t])[0].id).not.toBe(a[0].id);
  });

  it("écarte une opération déjà importée par fichier (même date et montant), une seule fois", () => {
    const l = [
      { date: "2026-11-02", montant: 1000 },
      { date: "2026-11-02", montant: 1000 },
      { date: "2026-11-03", montant: 500 },
    ];
    expect(sansDoublonsImport(l, [{ date: "2026-11-02", montant: 1000 }])).toEqual([
      { date: "2026-11-02", montant: 1000 },
      { date: "2026-11-03", montant: 500 },
    ]);
  });

  it("tolère un décalage de date entre fichier (date d'opération) et banque (date comptable)", () => {
    const l = [{ date: "2026-10-31", montant: -52 }, { date: "2026-10-31", montant: -52 }, { date: "2026-10-20", montant: -52 }];
    expect(sansDoublonsImport(l, [{ date: "2026-10-30", montant: -52 }])).toEqual([{ date: "2026-10-31", montant: -52 }, { date: "2026-10-20", montant: -52 }]);
  });

  it("calcule la date de début et la cadence", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(debutReleve(undefined, now)).toBe("2026-08-07");
    expect(debutReleve("2026-11-04", now)).toBe("2026-10-30");
    expect(debutReleve("2026-01-01", now)).toBe("2026-08-07");
    expect(releveBanqueDu(undefined, now)).toBe(true);
    expect(releveBanqueDu(now - 3600_000, now)).toBe(false);
    expect(releveBanqueDu(now - 9 * 3600_000, now)).toBe(true);
    expect(joursRestants("2026-11-20T12:00:00Z", now)).toBe(15);
  });

  it("met la Caisse d'Épargne Île-de-France en premier", () => {
    const l = trierBanques([{ name: "BNP Paribas" }, { name: "Caisse d'Epargne Normandie" }, { name: "Caisse d'Epargne Ile de France" }]);
    expect(l.map((b) => b.name)).toEqual(["Caisse d'Epargne Ile de France", "Caisse d'Epargne Normandie", "BNP Paribas"]);
  });
});

import { generateKeyPairSync, createPrivateKey } from "node:crypto";
import { normaliserPem } from "../banque";

describe("normaliserPem", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
  const ok = (s: string) => {
    const r = normaliserPem(s);
    if ("erreur" in r) throw new Error(r.erreur);
    return createPrivateKey(r.pem).asymmetricKeyType;
  };

  it("accepte le fichier tel quel, PKCS8 ou PKCS1", () => {
    expect(ok(pkcs8)).toBe("rsa");
    expect(ok(pkcs1)).toBe("rsa");
  });
  it("répare les retours à la ligne perdus ou échappés, les guillemets, le base64 du fichier", () => {
    expect(ok(pkcs8.replace(/\n/g, " "))).toBe("rsa");
    expect(ok(pkcs8.replace(/\n/g, "\r\n"))).toBe("rsa");
    expect(ok(`"${pkcs8.replace(/\n/g, "\\n")}"`)).toBe("rsa");
    expect(ok(Buffer.from(pkcs8).toString("base64"))).toBe("rsa");
  });
  it("explique un texte coupé, un certificat ou un nom de fichier", () => {
    expect(normaliserPem(pkcs8.slice(0, 300))).toHaveProperty("erreur");
    expect(normaliserPem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----")).toEqual({ erreur: expect.stringContaining("CERTIFICATE") });
    expect(normaliserPem("2307a280.pem")).toHaveProperty("erreur");
  });
});

import { appelLectureSeule } from "../banque";

describe("verrou lecture seule", () => {
  it("autorise uniquement la lecture", () => {
    expect(appelLectureSeule("GET", "/aspsps?country=FR&service=AIS")).toBe(true);
    expect(appelLectureSeule("POST", "/auth")).toBe(true);
    expect(appelLectureSeule("POST", "/sessions")).toBe(true);
    expect(appelLectureSeule("DELETE", "/sessions/abc-123")).toBe(true);
    expect(appelLectureSeule("GET", "/accounts/7f3e-11/transactions?date_from=2026-10-01&continuation_key=x")).toBe(true);
  });
  it("refuse paiements, virements et tout autre appel", () => {
    expect(appelLectureSeule("POST", "/payments")).toBe(false);
    expect(appelLectureSeule("GET", "/payments/123")).toBe(false);
    expect(appelLectureSeule("POST", "/accounts/1/transactions")).toBe(false);
    expect(appelLectureSeule("GET", "/accounts/1/transactions/../../payments")).toBe(false);
    expect(appelLectureSeule("GET", "/aspsps/payments")).toBe(false);
    expect(appelLectureSeule("PUT", "/sessions/1")).toBe(false);
    expect(appelLectureSeule("GET", "/accounts/1/balances")).toBe(false);
  });
});
