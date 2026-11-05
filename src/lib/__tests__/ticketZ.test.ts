import { describe, expect, it } from "vitest";
import { rowsToUberJours } from "../cashImport";
import { categorie, comparerCB, comparerUber, comparerUberJour, controleTotal, jourDuTicket, semaineUber, totaux } from "../ticketZ";

describe("ticket Z", () => {
  it("un Z clôturé après minuit appartient à la veille", () => {
    expect(jourDuTicket("2026-11-05", "00:53")).toBe("2026-11-04");
    expect(jourDuTicket("2026-11-01", "01:10")).toBe("2026-10-31");
    expect(jourDuTicket("2026-11-04", "23:40")).toBe("2026-11-04");
    expect(jourDuTicket("2026-11-04")).toBe("2026-11-04");
  });

  it("range les moyens de paiement", () => {
    expect(categorie("Uber Eats")).toBe("uber");
    expect(categorie("CB")).toBe("cb");
    expect(categorie("Carte bancaire sans contact")).toBe("cb");
    expect(categorie("AMEX")).toBe("cb");
    expect(categorie("Espèces")).toBe("especes");
    expect(categorie("Swile")).toBe("ticketsResto");
    expect(categorie("Ticket restaurant")).toBe("ticketsResto");
    expect(categorie("Chèque")).toBe("autres");
  });

  it("totaux, commandes Uber et contrôle du total", () => {
    const paiements = [
      { libelle: "CB", montant: 150000, categorie: "cb" as const },
      { libelle: "Uber Eats", montant: 90100, categorie: "uber" as const, nombre: 25 },
      { libelle: "Espèces", montant: 20000, categorie: "especes" as const },
    ];
    const t = totaux(paiements);
    expect(t).toMatchObject({ cb: 150000, uber: 90100, uberCommandes: 25, especes: 20000, somme: 260100 });
    expect(controleTotal({ dateTicket: "2026-11-05", paiements, total: 260100 }).statut).toBe("ok");
    expect(controleTotal({ dateTicket: "2026-11-05", paiements, total: 270100 })).toMatchObject({ statut: "ecart", ecart: -10000 });
  });

  it("CB : remise J+1 avec commission", () => {
    const r = comparerCB(
      "2026-11-04",
      [{ id: "a", date: "2026-11-04", amount: 150000 }],
      [{ id: "b", date: "2026-11-05", amount: 148500, libelle: "REMISE CB" }],
      { today: "2026-11-10" },
    );
    expect(r).toMatchObject({ statut: "ok", ecart: -1500, banque: { jours: 1 } });
  });

  it("CB : rien en banque → attente les premiers jours, écart ensuite", () => {
    const cash = [{ id: "a", date: "2026-11-04", amount: 150000 }];
    expect(comparerCB("2026-11-04", cash, [], { today: "2026-11-05" }).statut).toBe("attente");
    expect(comparerCB("2026-11-04", cash, [], { today: "2026-11-20" }).statut).toBe("ecart");
  });

  it("Uber du jour : même nombre de commandes et même montant", () => {
    expect(comparerUberJour({ commandes: 25, montant: 90100 }, { date: "d", commandes: 25, ventes: 90100 }).statut).toBe("ok");
    expect(comparerUberJour({ commandes: 25, montant: 90100 }, { date: "d", commandes: 24, ventes: 86000 })).toMatchObject({
      statut: "ecart",
      ecartCommandes: -1,
      ecartMontant: -4100,
    });
    expect(comparerUberJour({ commandes: 25, montant: 90100 }, undefined).statut).toBe("attente");
  });

  it("Uber de la semaine contre le versement du lundi", () => {
    expect(semaineUber("2026-11-04")).toEqual({ debut: "2026-11-02", fin: "2026-11-08" });
    const jours = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, date: `2026-11-0${i + 2}`, amount: 10000 }));
    const r = comparerUber("2026-11-04", jours, [{ id: "v", date: "2026-11-09", montant: 52000, brut: 70000 }], { today: "2026-11-10" });
    expect(r).toMatchObject({ statut: "ok", caisseSemaine: 70000, joursSaisis: 7, ecart: 0 });
  });

  it("commandes Uber par jour depuis l'export du Manager", () => {
    const jours = rowsToUberJours([
      { datedelacommande: "04/11/2026 20:15", ventesttc: "36,04", statut: "Livrée" },
      { datedelacommande: "05/11/2026 00:20", ventesttc: "10", statut: "Livrée" },
      { datedelacommande: "04/11/2026 21:00", ventesttc: "12", statut: "Annulée" },
      { datedelacommande: "05/11/2026 12:00", ventesttc: "20", statut: "Livrée" },
    ]);
    expect(jours).toEqual([
      { date: "2026-11-04", commandes: 2, ventes: 4604 },
      { date: "2026-11-05", commandes: 1, ventes: 2000 },
    ]);
  });
});

import { comparerUberBanque, pire } from "../ticketZ";

describe("triangulation Uber", () => {
  const v = { id: "v", date: "2026-11-09", montant: 52000, brut: 70000 };
  it("net du mail retrouvé en banque", () => {
    const r = comparerUberBanque(v, [{ id: "b", date: "2026-11-10", amount: 52000, libelle: "VIR UBER EATS" }], { today: "2026-11-20" });
    expect(r).toMatchObject({ statut: "ok", virement: { jours: 1 } });
  });
  it("montant différent en banque → écart une fois le délai passé", () => {
    const b = [{ id: "b", date: "2026-11-10", amount: 51000, libelle: "VIR UBER EATS" }];
    expect(comparerUberBanque(v, b, { today: "2026-11-11" }).statut).toBe("attente");
    expect(comparerUberBanque(v, b, { today: "2026-11-20" }).statut).toBe("ecart");
  });
  it("le pire statut l'emporte", () => {
    expect(pire("ok", "attente")).toBe("attente");
    expect(pire("ok", "ecart", "attente")).toBe("ecart");
    expect(pire("ok", "ok")).toBe("ok");
  });
});

describe("semaine Uber du récap mail", () => {
  const jours = Array.from({ length: 7 }, (_, i) => ({ id: `${i}`, date: `2026-11-0${i + 2}`, amount: 10000 }));
  it("utilise la période debut/fin du mail", () => {
    const v = { id: "mail-2026-11-09", date: "2026-11-09", montant: 52000, brut: 70000, debut: "2026-11-02", fin: "2026-11-08" };
    const r = comparerUber("2026-11-04", jours, [v], { today: "2026-11-10" });
    expect(r).toMatchObject({ statut: "ok", versement: { id: "mail-2026-11-09" } });
  });
  it("petit écart (commandes après minuit) → proche, gros écart → écart", () => {
    const v = (brut: number) => [{ id: "v", date: "2026-11-09", montant: 52000, brut, debut: "2026-11-02", fin: "2026-11-08" }];
    expect(comparerUber("2026-11-04", jours, v(68500), { today: "2026-11-10" }).statut).toBe("proche");
    expect(comparerUber("2026-11-04", jours, v(60000), { today: "2026-11-10" }).statut).toBe("ecart");
  });
});

import { codeLibelle, remisesDuJour } from "../ticketZ";

describe("remises CB Caisse d'Épargne", () => {
  const lignes = [
    { id: "1", date: "2026-10-31", amount: 120000, libelle: "CB TIB S 301026 CONTRAT 8060564" },
    { id: "2", date: "2026-10-31", amount: 30050, libelle: "CB TIB S 301026 CONTRAT 8060565" },
    { id: "3", date: "2026-10-31", amount: -45, libelle: "CB COM TIB S 301026" },
    { id: "4", date: "2026-10-31", amount: -12, libelle: "CB COM TIB S 301026" },
    { id: "5", date: "2026-11-01", amount: 99000, libelle: "CB TIB S 311026" },
  ];
  it("code JJMMAA", () => expect(codeLibelle("2026-10-30")).toBe("301026"));
  it("additionne les contrats TPE et isole les frais", () => {
    expect(remisesDuJour("2026-10-30", lignes)).toMatchObject({ remises: [{ id: "1" }, { id: "2" }], frais: 57 });
  });
  it("CB du Z = somme des remises du jour", () => {
    const r = comparerCB("2026-10-30", [{ id: "z", date: "2026-10-30", amount: 150050 }], lignes.filter((l) => l.amount > 0), { lignes, today: "2026-11-05" });
    expect(r).toMatchObject({ statut: "ok", ecart: 0, frais: 57, banque: { montant: 150050, jours: 1 } });
  });
  it("écart si la somme ne colle pas", () => {
    const r = comparerCB("2026-10-30", [{ id: "z", date: "2026-10-30", amount: 160000 }], [], { lignes, today: "2026-11-05" });
    expect(r).toMatchObject({ statut: "ecart", ecart: -9950 });
  });
});
