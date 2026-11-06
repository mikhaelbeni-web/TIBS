import { describe, expect, it } from "vitest";
import { rowsToUberJours } from "../cashImport";
import { categorie, comparerCB, comparerUber, comparerUberJour, controleTotal, estRemiseCB, jourDuTicket, semaineUber, totaux } from "../ticketZ";

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

describe("remises CB Caisse d'Épargne (relevé réel d'octobre 2026)", () => {
  // Remises par jour de crédit et date de libellé, montants en centimes.
  const brut: [string, string, number[]][] = [
    ["2026-10-15", "151026", [12900, 13400, 14050, 31800, 56850, 64660, 103600, 130800]],
    ["2026-10-16", "151026", [1000, 10850, 14100, 21550, 22160, 22800, 28750]],
    ["2026-10-16", "161026", [49600, 53150, 93000, 149850]],
    ["2026-10-17", "161026", [3900, 7750, 7850, 10200, 17850, 37450]],
    ["2026-10-19", "181026", [8300, 8800, 9250, 10350, 10400, 12600, 13750, 14050, 24100, 24200, 24300, 31850, 35150, 60650, 66450, 76150, 143650]],
    ["2026-10-19", "191026", [1200, 14100, 27950, 94200, 94450, 112350, 226350]],
    ["2026-10-20", "191026", [10250, 10360, 42775]],
    ["2026-10-20", "201026", [7550, 32450, 68450, 91650, 107400]],
    ["2026-10-21", "191026", [16205]],
    ["2026-10-21", "201026", [4750, 8000, 10050, 10700, 15300, 31785, 33400]],
    ["2026-10-21", "211026", [46350, 85150, 87200, 162200]],
  ];
  const lignes = [
    ...brut.flatMap(([date, code, montants]) =>
      montants.map((amount, i) => ({ id: `${date}-${code}-${i}`, date, amount, libelle: `CB TIB S ${code} CONTRAT 806056` })),
    ),
    { id: "com", date: "2026-10-19", amount: -653, libelle: "CB COM TIB S 181026" },
    { id: "swile", date: "2026-10-19", amount: 26334, libelle: "VIR SEPA SWILE" },
  ];
  // CB par service, export « Détails par service » de L'Addition.
  const caisse = [
    ["2026-10-15", 469235],
    ["2026-10-16", 85000],
    ["2026-10-17", 463200],
    ["2026-10-18", 683400],
    ["2026-10-19", 387090],
    ["2026-10-20", 494885],
  ].map(([date, amount]) => ({ id: String(date), date: String(date), amount: Number(amount) }));
  const cb = (jour: string) => comparerCB(jour, caisse, lignes.filter((l) => l.amount > 0), { lignes, today: "2026-11-05" });

  it("reconnaît les remises, pas les frais ni les virements", () => {
    expect(estRemiseCB(lignes[0])).toBe(true);
    expect(estRemiseCB({ id: "c", date: "d", amount: -653, libelle: "CB COM TIB S 181026" })).toBe(false);
    expect(estRemiseCB({ id: "s", date: "d", amount: 26334, libelle: "VIR SEPA SWILE" })).toBe(false);
  });
  it("une journée = remises créditées le jour bancaire suivant, quelle que soit la date du libellé", () => {
    expect(cb("2026-10-16")).toMatchObject({ statut: "ok", caisse: 85000, ecart: 0, banque: { date: "2026-10-17", montant: 85000, jours: 1 } });
    expect(cb("2026-10-15")).toMatchObject({ statut: "ecart", banque: { date: "2026-10-16", montant: 466810 }, ecart: -2425 });
  });
  it("samedi soir et dimanche sont crédités ensemble le lundi", () => {
    const r = cb("2026-10-18");
    expect(r).toMatchObject({ caisse: 1146600, banque: { date: "2026-10-19", montant: 1144600 }, ecart: -2000 });
    expect(r.joursCouverts?.map((c) => c.date)).toEqual(["2026-10-17", "2026-10-18"]);
    expect(cb("2026-10-17").banque?.date).toBe("2026-10-19");
  });
  it("un paiement envoyé une nuit plus tard : les deux jours se compensent", () => {
    expect(cb("2026-10-19")).toMatchObject({ statut: "proche", ecart: -16205, voisin: { credit: "2026-10-21", ecart: 16205 } });
    expect(cb("2026-10-20")).toMatchObject({ statut: "proche", ecart: 16205, voisin: { credit: "2026-10-20", ecart: -16205 } });
  });
  it("écart cumulé du mois", () => {
    expect(cb("2026-10-20").cumul).toEqual({ depuis: "2026-10-15", caisse: 2582810, banque: 2578385, ecart: -4425 });
  });
  it("pas encore crédité → attente", () => {
    const r = comparerCB("2026-10-21", [{ id: "z", date: "2026-10-21", amount: 400000 }], [], { lignes, today: "2026-10-22" });
    expect(r.statut).toBe("attente");
  });
  it("le piège du libellé : « 021126 » crédité le 02/11 appartient au dimanche, pas au lundi", () => {
    const nov = [
      { id: "a", date: "2026-11-02", amount: 795650, libelle: "CB TIB S 021126 CONTRAT 806056" },
      { id: "b", date: "2026-11-03", amount: 103910, libelle: "CB TIB S 021126 CONTRAT 806056" },
      { id: "c", date: "2026-11-03", amount: 169000, libelle: "CB TIB S 031126 CONTRAT 806056" },
    ];
    const r = comparerCB("2026-11-02", [{ id: "z", date: "2026-11-02", amount: 272910 }], nov, { today: "2026-11-05" });
    expect(r).toMatchObject({ statut: "ok", ecart: 0, banque: { date: "2026-11-03", montant: 272910 } });
  });
});

describe("remises CB, début novembre 2026 (captures de Jour à jour)", () => {
  const credits: [string, string, number[]][] = [
    ["2026-11-02", "011126", [171850, 205400, 177450, 16100, 12550, 11500, 15550, 20600, 31350, 11000, 143150, 15950]],
    ["2026-11-02", "021126", [7800, 19650, 18200, 30300, 39350, 24350, 20150, 114000, 49750, 3500, 218850, 249750]],
    ["2026-11-03", "031126", [70950, 70250, 41600, 16350]],
    ["2026-11-03", "021126", [30150, 14750, 6160, 10800, 18150, 15650, 8250]],
    ["2026-11-04", "041126", [28300, 5400, 9400, 92800, 132750, 11700, 76400, 32700]],
    ["2026-11-04", "031126", [16185]],
    ["2026-11-05", "051126", [141833, 6250, 70450, 6655, 24050, 5450, 39000, 35300]],
    ["2026-11-05", "041126", [17170]],
  ];
  const lignes = credits.flatMap(([date, code, montants]) =>
    montants.map((amount, i) => ({ id: `${date}-${code}-${i}`, date, amount, libelle: `CB TIB S ${code} CONTRAT 8060565` })),
  );
  const caisse = [
    ["2026-10-31", 842850],
    ["2026-11-01", 825800],
    ["2026-11-02", 272910],
    ["2026-11-03", 429255],
    ["2026-11-04", 336755],
  ].map(([date, amount]) => ({ id: String(date), date: String(date), amount: Number(amount) }));
  const cb = (jour: string) => comparerCB(jour, caisse, lignes, { today: "2026-11-06" });

  it("week-end de la Toussaint : samedi + dimanche contre le crédit du lundi", () => {
    expect(cb("2026-11-01")).toMatchObject({ statut: "ecart", caisse: 1668650, ecart: -40550, cumul: { depuis: "2026-10-31", ecart: -40550 } });
  });
  it("excédent égal au centime à une remise : envoyée en retard, signalée", () => {
    const r = cb("2026-11-02");
    expect(r).toMatchObject({ statut: "proche", ecart: 30150, remiseExacte: { sens: "excedent", remise: { amount: 30150 } } });
  });
  it("écarts sans remise correspondante restent des écarts ; cumul depuis le 02/11", () => {
    expect(cb("2026-11-03")).toMatchObject({ statut: "ecart", ecart: -23620 });
    expect(cb("2026-11-04")).toMatchObject({ statut: "ecart", ecart: 9403, cumul: { depuis: "2026-11-02", caisse: 1038920, banque: 1054853, ecart: 15933 } });
  });
  it("montant manquant retrouvé au centime dans le crédit suivant", () => {
    const tard = [...lignes, { id: "tard", date: "2026-11-05", amount: 23620, libelle: "CB TIB S 041126 CONTRAT 8060564" }];
    const r = comparerCB("2026-11-03", caisse, tard, { today: "2026-11-06" });
    expect(r).toMatchObject({ statut: "proche", remiseExacte: { sens: "manquant", remise: { id: "tard", date: "2026-11-05" } } });
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
