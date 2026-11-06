import { describe, expect, it } from "vitest";
import { rowsToUberJours } from "../cashImport";
import { bilanCB } from "../controleCB";
import {
  categorie,
  comparerCB,
  comparerUber,
  comparerUberJour,
  controleTotal,
  creditEffectif,
  deduireValeurs,
  estRemiseCB,
  jourDuTicket,
  pointageMoisCB,
  semaineUber,
  suiviTitres,
  totaux,
} from "../ticketZ";

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
      { date: "2026-11-04", commandes: 2, ventes: 4604, partiel: true },
      { date: "2026-11-05", commandes: 1, ventes: 2000, partiel: true },
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

// Montants fictifs (le dépôt est public) ; la structure reproduit celle du relevé Caisse d'Épargne :
// plusieurs remises par jour, libellé daté de l'envoi par le TPE, crédit le jour bancaire suivant.
const remisesCB = (lots: [string, string, number[]][]) =>
  lots.flatMap(([date, code, montants]) =>
    montants.map((amount, i) => ({ id: `${date}-${code}-${i}`, date, amount, libelle: `CB TIB S ${code} CONTRAT 1234567` })),
  );
const journees = (l: [string, number][]) => l.map(([date, amount]) => ({ id: date, date, amount }));

describe("remises CB Caisse d'Épargne", () => {
  const lignes = [
    ...remisesCB([
      ["2026-10-15", "151026", [40000, 60000]],
      ["2026-10-16", "151026", [25000, 15000]],
      ["2026-10-16", "161026", [57575]],
      ["2026-10-17", "161026", [12000, 18000]],
      ["2026-10-19", "181026", [100000, 90000, 50000]],
      ["2026-10-19", "191026", [28000]],
      ["2026-10-20", "191026", [30000, 10000]],
      ["2026-10-20", "201026", [33795]],
      ["2026-10-21", "191026", [16205]],
      ["2026-10-21", "201026", [40000, 30000]],
      ["2026-10-21", "211026", [40000]],
    ]),
    { id: "com", date: "2026-10-19", amount: -653, libelle: "CB COM TIB S 181026" },
    { id: "tr", date: "2026-10-19", amount: 10000, libelle: "VIR SEPA SWILE" },
  ];
  const caisse = journees([
    ["2026-10-15", 100000],
    ["2026-10-16", 30000],
    ["2026-10-17", 120000],
    ["2026-10-18", 150000],
    ["2026-10-19", 90000],
    ["2026-10-20", 110000],
  ]);
  const cb = (jour: string) => comparerCB(jour, caisse, lignes.filter((l) => l.amount > 0), { lignes, today: "2026-11-05" });

  it("reconnaît les remises, pas les frais ni les virements", () => {
    expect(estRemiseCB(lignes[0])).toBe(true);
    expect(estRemiseCB({ id: "c", date: "d", amount: -653, libelle: "CB COM TIB S 181026" })).toBe(false);
    expect(estRemiseCB({ id: "s", date: "d", amount: 10000, libelle: "VIR SEPA SWILE" })).toBe(false);
  });
  it("une journée = remises créditées le jour bancaire suivant, quelle que soit la date du libellé", () => {
    expect(cb("2026-10-16")).toMatchObject({ statut: "ok", caisse: 30000, ecart: 0, banque: { date: "2026-10-17", montant: 30000, jours: 1 } });
    // Petit manque en banque : tickets-resto saisis « CB » en caisse, payés à part par l'émetteur.
    expect(cb("2026-10-15")).toMatchObject({ statut: "ok", titres: 2425, banque: { date: "2026-10-16", montant: 97575 }, ecart: -2425 });
  });
  it("samedi soir et dimanche sont crédités ensemble le lundi", () => {
    const r = cb("2026-10-18");
    expect(r).toMatchObject({ caisse: 270000, banque: { date: "2026-10-19", montant: 268000 }, ecart: -2000 });
    expect(r.joursCouverts?.map((c) => c.date)).toEqual(["2026-10-17", "2026-10-18"]);
    expect(cb("2026-10-17").banque?.date).toBe("2026-10-19");
  });
  it("un paiement envoyé une nuit plus tard : les deux jours se compensent", () => {
    expect(cb("2026-10-19")).toMatchObject({ statut: "proche", ecart: -16205, voisin: { credit: "2026-10-21", ecart: 16205 } });
    expect(cb("2026-10-20")).toMatchObject({ statut: "proche", ecart: 16205, voisin: { credit: "2026-10-20", ecart: -16205 } });
  });
  it("écart cumulé du mois", () => {
    expect(cb("2026-10-20").cumul).toEqual({ depuis: "2026-10-15", caisse: 600000, banque: 595575, ecart: -4425 });
  });
  it("pas encore crédité → attente", () => {
    const r = comparerCB("2026-10-21", [{ id: "z", date: "2026-10-21", amount: 400000 }], [], { lignes, today: "2026-10-22" });
    expect(r.statut).toBe("attente");
  });
  it("le piège du libellé : « 021126 » crédité le 02/11 appartient au dimanche, pas au lundi", () => {
    const nov = remisesCB([
      ["2026-11-02", "021126", [500000]],
      ["2026-11-03", "021126", [40000]],
      ["2026-11-03", "031126", [60000]],
    ]);
    const r = comparerCB("2026-11-02", [{ id: "z", date: "2026-11-02", amount: 100000 }], nov, { today: "2026-11-05" });
    expect(r).toMatchObject({ statut: "ok", ecart: 0, banque: { date: "2026-11-03", montant: 100000 } });
  });
  it("pointage du mois : un rapprochement par jour de crédit, toutes remises comprises", () => {
    const p = pointageMoisCB("2026-10", caisse, lignes.filter((l) => l.amount > 0), { lignes, today: "2026-11-05" });
    expect(p.groupes.map((g) => [g.banque?.date, g.joursCouverts?.map((j) => j.date), g.ecart])).toEqual([
      ["2026-10-16", ["2026-10-15"], -2425],
      ["2026-10-17", ["2026-10-16"], 0],
      ["2026-10-19", ["2026-10-17", "2026-10-18"], -2000],
      ["2026-10-20", ["2026-10-19"], -16205],
      ["2026-10-21", ["2026-10-20"], 16205],
    ]);
    expect(p.sansRemise).toEqual([]);
    // Créditées le 15 : service du 14, absent de la caisse.
    expect(p.remisesSeules.map((b) => b.amount)).toEqual([40000, 60000]);
    // Le mois suivant ne reprend pas les journées d'octobre ; leurs remises ne sont pas « seules ».
    const nov = pointageMoisCB("2026-11", caisse, lignes.filter((l) => l.amount > 0), { lignes, today: "2026-11-05" });
    expect(nov).toEqual({ groupes: [], sansRemise: [], remisesSeules: [] });
  });
  it("pointage du mois : journée sans remise", () => {
    const p = pointageMoisCB("2026-10", [...caisse, { id: "2026-10-21", date: "2026-10-21", amount: 50000 }], lignes.filter((l) => l.amount > 0), {
      lignes,
      today: "2026-10-22",
    });
    expect(p.sansRemise).toEqual([{ jour: { id: "2026-10-21", date: "2026-10-21", amount: 50000 }, statut: "attente" }]);
  });
});

describe("remises CB : lot envoyé en retard, cumul à cheval sur deux mois", () => {
  const lignes = remisesCB([
    ["2026-11-02", "011126", [300000, 200000]],
    ["2026-11-02", "021126", [100000]],
    ["2026-11-03", "031126", [70000, 49000]],
    ["2026-11-03", "021126", [25000, 31000]],
    ["2026-11-04", "041126", [100000, 80000]],
    ["2026-11-04", "031126", [15000]],
    ["2026-11-05", "051126", [90000, 33333]],
    ["2026-11-05", "041126", [10000]],
  ]);
  const caisse = journees([
    ["2026-10-31", 250000],
    ["2026-11-01", 380000],
    ["2026-11-02", 150000],
    ["2026-11-03", 200000],
    ["2026-11-04", 130000],
  ]);
  const cb = (jour: string) => comparerCB(jour, caisse, lignes, { today: "2026-11-06" });

  it("week-end : samedi + dimanche contre le crédit du lundi, cumul depuis le samedi", () => {
    expect(cb("2026-11-01")).toMatchObject({ statut: "ecart", caisse: 630000, ecart: -30000, cumul: { depuis: "2026-10-31", ecart: -30000 } });
  });
  it("excédent égal au centime à une remise : envoyée en retard, signalée", () => {
    expect(cb("2026-11-02")).toMatchObject({ statut: "proche", ecart: 25000, remiseExacte: { sens: "excedent", remise: { amount: 25000 } } });
  });
  it("excédent sans remise correspondante reste un écart, petit manque signalé ; cumul depuis le 02/11", () => {
    expect(cb("2026-11-03")).toMatchObject({ statut: "ok", ecart: -5000, titres: 5000 });
    expect(cb("2026-11-04")).toMatchObject({ statut: "ecart", ecart: 3333, cumul: { depuis: "2026-11-02", caisse: 480000, banque: 503333, ecart: 23333 } });
  });
  it("montant manquant retrouvé au centime dans le crédit suivant", () => {
    const tard = [...lignes, { id: "tard", date: "2026-11-05", amount: 5000, libelle: "CB TIB S 041126 CONTRAT 1234567" }];
    const r = comparerCB("2026-11-03", caisse, tard, { today: "2026-11-06" });
    expect(r).toMatchObject({ statut: "proche", remiseExacte: { sens: "manquant", remise: { id: "tard", date: "2026-11-05" } } });
  });
});

describe("remises CB : date de valeur", () => {
  // Lundi 100 000, mardi 80 000. Un lot de 5 000 du lundi soir est télécollecté le mardi matin : crédité mercredi,
  // valeur mardi. Sans la date de valeur, lundi -50 € et mardi +50 €.
  const base = [
    ...remisesCB([
      ["2026-10-20", "191026", [60000, 35000]],
      ["2026-10-21", "201026", [80000]],
    ]),
    { id: "matin", date: "2026-10-21", amount: 5000, libelle: "CB TIB S 201026 CONTRAT 1234565" },
  ];
  const avecValeur = base.map((b) => ({ ...b, valeur: b.id === "matin" ? "2026-10-20" : b.date }));
  const caisse = journees([
    ["2026-10-19", 100000],
    ["2026-10-20", 80000],
  ]);
  const cb = (jour: string, lignes: typeof base) => comparerCB(jour, caisse, lignes, { today: "2026-11-06" });

  it("une remise dont la valeur précède le crédit revient au service de la veille", () => {
    expect(creditEffectif(avecValeur[3])).toBe("2026-10-20");
    expect(cb("2026-10-19", avecValeur)).toMatchObject({ statut: "ok", ecart: 0, banque: { date: "2026-10-20", montant: 100000 } });
    expect(cb("2026-10-20", avecValeur)).toMatchObject({ statut: "ok", ecart: 0, banque: { date: "2026-10-21", montant: 80000 } });
    expect(cb("2026-10-19", avecValeur).remises?.map((b) => b.id)).toContain("matin");
  });
  it("sans date de valeur, le même lot se voit seulement par compensation entre les deux jours", () => {
    expect(cb("2026-10-19", base)).toMatchObject({ statut: "proche", ecart: -5000 });
    expect(cb("2026-10-20", base)).toMatchObject({ statut: "proche", ecart: 5000, voisin: { credit: "2026-10-20" } });
  });
  it("une valeur postérieure au crédit (lot du vendredi, valeur lundi) ne change rien", () => {
    const ven = remisesCB([["2026-10-24", "231026", [27750]]]).map((b) => ({ ...b, valeur: "2026-10-26" }));
    const r = comparerCB("2026-10-23", journees([["2026-10-23", 27750]]), ven, { today: "2026-11-06" });
    expect(r).toMatchObject({ statut: "ok", banque: { date: "2026-10-24" } });
  });
  it("seul un petit manque (200 € au plus) est mis sur le compte des tickets-resto ; un excédent reste un écart", () => {
    const une = (montant: number) =>
      comparerCB("2026-10-27", journees([["2026-10-27", 400000]]), remisesCB([["2026-10-28", "271026", [montant]]]), { today: "2026-11-06" });
    expect(une(400000 - 7350)).toMatchObject({ statut: "ok", titres: 7350 });
    expect(une(400000 - 20000)).toMatchObject({ statut: "ok", titres: 20000 });
    expect(une(400000 - 25000)).toMatchObject({ statut: "ecart" });
    expect(une(400000 + 7350).statut).toBe("ecart");
  });
});

describe("remises CB : lot du matin retrouvé sans date de valeur", () => {
  // Comme le relevé automatique de la Caisse d'Épargne : pas de date de valeur, n° de remise dans le libellé.
  const lot = (id: string, date: string, amount: number, rem: string) => ({ id, date, amount, libelle: `CB TIB S 000000 CONTRAT 1234565 REM ${rem}` });
  const lignes = [
    lot("lun1", "2026-10-20", 60000, "112345"),
    lot("lun2", "2026-10-20", 35000, "054321"),
    lot("mar1", "2026-10-21", 80000, "112346"),
    lot("matin", "2026-10-21", 5000, "012345"),
    lot("mer1", "2026-10-22", 40000, "112347"),
    lot("mer2", "2026-10-22", 30000, "054000"),
  ];
  const caisse = journees([
    ["2026-10-19", 100000],
    ["2026-10-20", 80000],
    ["2026-10-21", 70000],
  ]);
  const cb = (jour: string, l = lignes, c = caisse, deduire = true) => comparerCB(jour, c, l, { today: "2026-11-06", deduire });

  it("le lot du matin revient au service de la veille, les autres restent", () => {
    const lun = cb("2026-10-19");
    expect(lun).toMatchObject({ statut: "ok", ecart: 0, banque: { date: "2026-10-20", montant: 100000 } });
    expect(lun.remises?.find((b) => b.id === "matin")).toMatchObject({ date: "2026-10-21", valeur: "2026-10-20", valeurDeduite: true });
    expect(cb("2026-10-20")).toMatchObject({ statut: "ok", ecart: 0, banque: { date: "2026-10-21", montant: 80000 } });
    expect(cb("2026-10-21")).toMatchObject({ statut: "ok", ecart: 0, banque: { date: "2026-10-22", montant: 70000 } });
    expect([...deduireValeurs(caisse, lignes)]).toEqual([["matin", "2026-10-20"]]);
  });
  it("sans déduction, le lot compte à son jour de crédit", () => {
    expect(cb("2026-10-19", lignes, caisse, false)).toMatchObject({ ecart: -5000 });
  });
  it("un lot numéroté 1xxxxx n'est jamais déplacé", () => {
    const l = lignes.map((b) => (b.id === "matin" ? lot("matin", b.date, b.amount, "112399") : b));
    expect(deduireValeurs(caisse, l).size).toBe(0);
    expect(cb("2026-10-19", l)).toMatchObject({ ecart: -5000 });
  });
  it("à égalité (deux manques), le lot va à la veille", () => {
    const l = [lot("a", "2026-10-20", 90000, "112345"), lot("b", "2026-10-21", 80000, "112346"), lot("m", "2026-10-21", 5000, "012345")];
    const c = journees([
      ["2026-10-19", 100000],
      ["2026-10-20", 86000],
    ]);
    expect([...deduireValeurs(c, l)]).toEqual([["m", "2026-10-20"]]);
  });
  it("pas de déplacement vers un crédit sans journée de caisse", () => {
    const l = [lot("a", "2026-10-20", 10000, "112345"), lot("b", "2026-10-21", 80000, "112346"), lot("m", "2026-10-21", 5000, "012345")];
    const c = journees([["2026-10-20", 80000]]);
    expect(deduireValeurs(c, l).size).toBe(0);
    expect(cb("2026-10-20", l, c)).toMatchObject({ ecart: 5000 });
  });
});

describe("tickets-resto passés en CB, payés à part par les émetteurs", () => {
  // Chaque journée : 2 % de la CB de caisse en cartes tickets-resto, absentes des remises CB.
  const caisse = journees([
    ["2026-10-05", 100000],
    ["2026-10-06", 50000],
    ["2026-10-07", 80000],
  ]);
  const remises = remisesCB([
    ["2026-10-06", "051026", [98000]],
    ["2026-10-07", "061026", [49000]],
    ["2026-10-08", "071026", [78400]],
  ]);
  const suivi = (mois: string, virement: string) => {
    const lignes = [...remises, { id: "tr", date: virement, amount: 4600, libelle: "VIR SEPA EDENRED FRANCE" }];
    return suiviTitres(mois, caisse, lignes.filter((b) => !/EDENRED/.test(b.libelle)), { lignes, today: "2026-11-20" });
  };
  it("chaque crédit compte son petit manque ; le virement groupé de l'émetteur le couvre", () => {
    expect(suivi("2026-10", "2026-10-14")).toMatchObject({
      mois: { passes: 4600, recus: 4600, virements: [{ id: "tr" }] },
      cumul: { depuis: "2026-10-06", passes: 4600, recus: 4600 },
    });
  });
  it("virement arrivé le mois suivant : à recevoir en fin de mois, couvert en cumul ensuite", () => {
    expect(suivi("2026-10", "2026-11-03")).toMatchObject({ mois: { passes: 4600, recus: 0 }, cumul: { passes: 4600, recus: 0 } });
    expect(suivi("2026-11", "2026-11-03")).toMatchObject({ mois: { passes: 0, recus: 4600 }, cumul: { passes: 4600, recus: 4600 } });
  });
});

describe("contrôle d'un mois en compteurs", () => {
  it("manque CB comparé aux virements titres-restaurant (paiement à la semaine)", () => {
    // Chaque journée : 2 % de la CB de caisse passés en carte titre-restaurant, payés par virement 7 jours plus tard.
    const caisse = journees([
      ["2026-10-05", 100000],
      ["2026-10-06", 50000],
      ["2026-10-07", 80000],
    ]);
    const lignes = [
      ...remisesCB([
        ["2026-10-06", "051026", [98000]],
        ["2026-10-07", "061026", [49000]],
        ["2026-10-08", "071026", [78400]],
      ]),
      { id: "tr", date: "2026-10-14", amount: 4600, libelle: "VIR SEPA CONECS TRD-123" },
      { id: "uber", date: "2026-10-12", amount: 30000, libelle: "VIR UBER EATS" },
      { id: "x", date: "2026-10-12", amount: 1000, libelle: "VIR SEPA DIVERS" },
    ];
    const b = bilanCB("2026-10", caisse, lignes, "2026-10-20");
    expect(b.diagnostic.familles).toEqual({ cb: 3, uber: 1, especes: 0, tr: 1, amex: 0, stripe: 0, autre: 1 });
    expect(b.diagnostic.manque).toEqual({ tr: 1, trDecale: 1, amex: 0, amexDecale: 0, trHorsUber: 1, trHorsUberDecale: 1, semainesUberAvecTitres: 0 });
    // Titres-restaurant d'une semaine Uber Eats versés à part par l'émetteur : retirés avant de comparer.
    const avecUber = bilanCB("2026-10", caisse, [...lignes, { id: "tr2", date: "2026-10-15", amount: 2000, libelle: "VIR EDENRED" }], "2026-10-20", [
      { fin: "2026-10-11", montant: 2000 },
    ]);
    expect(avecUber.diagnostic.manque).toMatchObject({ tr: 1.45, trHorsUber: 1, semainesUberAvecTitres: 1 });
    expect(b.diagnostic.creditsSansCaisse).toEqual([]);
    // 05/10/2026 = lundi : -2 % ; 06 = mardi : -2 % ; 07 = mercredi : -2 %.
    expect(b.diagnostic.parJour).toEqual({ lun: { credits: 1, pourcent: -2 }, mar: { credits: 1, pourcent: -2 }, mer: { credits: 1, pourcent: -2 } });
  });
  it("compte les groupes exacts, en plus et en moins, avec et sans date de valeur", () => {
    const lignes = [
      ...remisesCB([
        ["2026-10-20", "191026", [95000]],
        ["2026-10-21", "201026", [80000]],
        ["2026-10-22", "211026", [69000]],
      ]),
      { id: "matin", date: "2026-10-21", amount: 5000, libelle: "CB TIB S 201026 CONTRAT 1", valeur: "2026-10-20" },
    ];
    const caisse = journees([
      ["2026-10-19", 100000],
      ["2026-10-20", 80000],
      ["2026-10-21", 70000],
      ["2026-10-22", 50000],
    ]);
    const b = bilanCB("2026-10", caisse, lignes, "2026-10-23");
    expect(b.jours).toBe(4);
    // Le manque de 10 € du 22 = tickets-resto. Sans date de valeur, le -50 € du 20 se compense avec le +50 € du 21 (voisin).
    expect(b.avecValeur).toEqual({ groupes: 3, exacts: 2, titres: 1, negatifs: 0, positifs: 0, sansCredit: 1 });
    expect(b.sansValeur).toEqual({ groupes: 3, exacts: 0, titres: 1, negatifs: 1, positifs: 1, sansCredit: 1 });
    // Sans n° de remise dans le libellé, rien n'est déduit.
    expect(b.deduite).toEqual(b.sansValeur);
    expect(b.lots).toEqual({ possibles: 0, deduits: 0 });
    expect(b.remises).toMatchObject({ remises: 4, avecValeur: 1, valeurAvant: 1, valeurApres: 0 });
  });
  it("lot du matin déduit : même résultat qu'avec la date de valeur", () => {
    const rem = (id: string, date: string, amount: number, n: string, valeur?: string) => ({
      id,
      date,
      amount,
      libelle: `CB TIB S 000000 CONTRAT 1 REM ${n}`,
      ...(valeur ? { valeur } : {}),
    });
    const lignes = [
      rem("a", "2026-10-20", 95000, "100001"),
      rem("b", "2026-10-21", 80000, "100002"),
      rem("c", "2026-10-22", 69000, "100003"),
      rem("matin", "2026-10-21", 5000, "000004", "2026-10-20"),
    ];
    const caisse = journees([
      ["2026-10-19", 100000],
      ["2026-10-20", 80000],
      ["2026-10-21", 70000],
      ["2026-10-22", 50000],
    ]);
    const b = bilanCB("2026-10", caisse, lignes, "2026-10-23");
    expect(b.deduite).toEqual(b.avecValeur);
    expect(b.sansValeur.positifs).toBe(1);
    expect(b.lots).toEqual({ possibles: 1, deduits: 1 });
  });
});

describe("export Historique des commandes du Manager Uber Eats", () => {
  // En-têtes déjà normalisés comme le fait readSpreadsheet.
  const ligne = (date: string, heure: string, montant: string, statut = "completed") => ({
    datedelacommande: date,
    heuredelacommande: `${date} ${heure}.000`,
    montantmoyendescommandes: montant,
    statutdelacommande: statut,
  });
  it("compte les commandes, ignore annulées et non honorées, range l'après-minuit sur la veille", () => {
    const jours = rowsToUberJours([
      ligne("2026-10-04", "12:00:00", "42.0"),
      ligne("2026-10-05", "21:04:28", "42.0"),
      ligne("2026-10-05", "23:10:00", "18.0"),
      ligne("2026-10-06", "00:21:15", "20.0"),
      ligne("2026-10-05", "22:00:00", "0.0", "canceled"),
      ligne("2026-10-05", "22:30:00", "25.0", "unfulfilled"),
      ligne("2026-10-07", "12:00:00", "10.0"),
    ]);
    expect(jours.find((j) => j.date === "2026-10-05")).toEqual({ date: "2026-10-05", commandes: 3, ventes: 8000 });
    expect(jours[0].partiel).toBe(true);
    expect(jours.at(-1)?.partiel).toBe(true);
  });
});

import { urlZAutorisee } from "../ticketZ";

describe("lien du ticket Z de L'Addition", () => {
  it("n'accepte que data.laddition.com", () => {
    expect(urlZAutorisee("https://data.laddition.com/scripts/reporting.php?action=Z&format=pdf&ts=1")?.hostname).toBe("data.laddition.com");
    expect(urlZAutorisee("http://data.laddition.com/scripts/reporting.php")?.protocol).toBe("https:");
    expect(urlZAutorisee("https://data.laddition.com.evil.com/x")).toBeNull();
    expect(urlZAutorisee("https://user:pw@data.laddition.com/x")).toBeNull();
    expect(urlZAutorisee("https://data.laddition.com:8443/x")).toBeNull();
    expect(urlZAutorisee("https://169.254.169.254/latest")).toBeNull();
    expect(urlZAutorisee(42)).toBeNull();
  });
});
