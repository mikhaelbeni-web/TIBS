import { describe, expect, it } from "vitest";
import { debutParDefaut, listerIncoherences, type EntreeCaisse } from "../incoherences";
import type { BankLine } from "../reconcile";

// Données fictives : une semaine de service, une remise CB par jour crédité le lendemain.
const remise = (date: string, amount: number, n = 1): BankLine => ({
  id: `r-${date}-${n}`,
  date,
  amount,
  libelle: `CB TIB S ${date.slice(8, 10)}${date.slice(5, 7)}${date.slice(2, 4)} CONTRAT 1234564 REM 1000${n}${date.slice(8, 10)}`,
});
const jour = (date: string, cb: number, extra: Partial<EntreeCaisse> = {}): EntreeCaisse => ({ id: date, date, cb, ...extra });
// Le relevé commence avant la période : une opération quelconque fin octobre.
const debut: BankLine = { id: "debut", date: "2026-10-25", amount: -500, libelle: "PRLV QUELCONQUE" };
const base = (cash: EntreeCaisse[], bank: BankLine[], today = "2026-11-20") =>
  listerIncoherences({ cash, bank: bank.length ? [debut, ...bank] : [], versementsUber: [], uberJours: [], today, depuis: "2026-11-01" });

describe("incohérences de l'accueil", () => {
  it("par défaut : depuis le 1er du mois précédent", () => {
    expect(debutParDefaut("2026-11-06")).toBe("2026-10-01");
    expect(debutParDefaut("2027-01-15")).toBe("2026-12-01");
  });

  it("tout concorde : rien à regarder", () => {
    const cash = [jour("2026-11-10", 100000), jour("2026-11-11", 80000), jour("2026-11-12", 90000)];
    const bank = [remise("2026-11-11", 100000), remise("2026-11-12", 80000), remise("2026-11-13", 90000)];
    const b = base(cash, bank);
    expect(b.liste).toEqual([]);
    expect(b.attente).toEqual([]);
  });

  it("petit manque (tickets-resto passés en CB) : expliqué, pas d'alerte", () => {
    const cash = [jour("2026-11-10", 100000), jour("2026-11-11", 80000), jour("2026-11-12", 90000)];
    const bank = [remise("2026-11-11", 99000), remise("2026-11-12", 80000), remise("2026-11-13", 90000)];
    expect(base(cash, bank).liste).toEqual([]);
  });

  it("gros manque CB : remonte, avec la journée à ouvrir", () => {
    const cash = [jour("2026-11-10", 100000), jour("2026-11-11", 80000), jour("2026-11-12", 90000)];
    const bank = [remise("2026-11-11", 60000), remise("2026-11-12", 80000), remise("2026-11-13", 90000)];
    const b = base(cash, bank);
    expect(b.liste).toHaveLength(1);
    expect(b.liste[0]).toMatchObject({ type: "cb", jour: "2026-11-10", ecart: -40000 });
    expect(b.liste[0].titre).toContain("manque");
  });

  it("trop d'argent en banque : remonte aussi", () => {
    const cash = [jour("2026-11-10", 100000), jour("2026-11-11", 80000), jour("2026-11-12", 90000)];
    // 35 € de trop, et aucune remise de ce montant (sinon : lot de la veille, expliqué).
    const bank = [remise("2026-11-11", 100000), remise("2026-11-12", 90000), remise("2026-11-12", 25000, 2), remise("2026-11-13", 90000)];
    const b = base(cash, bank);
    expect(b.liste.map((x) => [x.type, x.ecart])).toEqual([["cb", 35000]]);
  });

  it("lot crédité un jour trop tard qui compense le jour voisin : expliqué", () => {
    const cash = [jour("2026-11-10", 100000), jour("2026-11-11", 80000), jour("2026-11-12", 90000)];
    const bank = [remise("2026-11-11", 70000), remise("2026-11-12", 80000), remise("2026-11-12", 30000, 2), remise("2026-11-13", 90000)];
    expect(base(cash, bank).liste).toEqual([]);
  });

  it("dernier crédit du relevé encore incomplet : en attente, pas en alerte", () => {
    const cash = [jour("2026-11-10", 100000), jour("2026-11-11", 80000)];
    const bank = [remise("2026-11-11", 100000), remise("2026-11-12", 30000)];
    const b = base(cash, bank, "2026-11-12");
    expect(b.liste).toEqual([]);
    expect(b.attente.map((a) => a.cle)).toEqual(["cb:2026-11-12"]);
    // Quatre jours plus tard sans rien de nouveau : c'est une vraie incohérence.
    const apres = base(cash, bank, "2026-11-16");
    expect(apres.liste.map((x) => x.type)).toEqual(["cb"]);
  });

  it("remise CB sans journée de caisse (ticket Z manquant) : remonte après 2 jours", () => {
    const cash = [jour("2026-11-10", 100000), jour("2026-11-12", 90000)];
    const bank = [remise("2026-11-11", 100000), remise("2026-11-12", 50000), remise("2026-11-13", 90000)];
    // La remise du 12 couvre le 11, sans journée de caisse.
    const b = base(cash, bank);
    expect(b.liste.map((x) => [x.type, x.date, x.jour])).toEqual([["remise_sans_caisse", "2026-11-12", "2026-11-11"]]);
  });

  it("aucun relevé bancaire (17e) : pas de contrôle CB, donc pas de fausse alerte", () => {
    const b = base([jour("2026-11-10", 100000), jour("2026-11-11", 80000)], []);
    expect(b.liste).toEqual([]);
  });

  it("ticket Z dont le total ne fait pas la somme des paiements", () => {
    const paiements = [
      { libelle: "CB", montant: 50000, categorie: "cb" },
      { libelle: "Espèces", montant: 20000, categorie: "especes" },
    ];
    const cash = [jour("2026-11-10", 50000, { paiements, total: 70000 }), jour("2026-11-11", 50000, { paiements, total: 75000 })];
    const b = base(cash, []);
    expect(b.liste.map((x) => [x.type, x.jour, x.ecart])).toEqual([["total_z", "2026-11-11", -5000]]);
  });

  it("Uber du jour : commandes ou montant différents du Manager", () => {
    const cash = [
      jour("2026-11-10", 0, { uber: 90100, uberCommandes: 25 }),
      jour("2026-11-11", 0, { uber: 50000, uberCommandes: 12 }),
      jour("2026-11-12", 0, { uber: 40000, uberCommandes: 10 }),
    ];
    const b = listerIncoherences({
      cash,
      bank: [],
      versementsUber: [],
      uberJours: [
        { date: "2026-11-10", commandes: 25, ventes: 90100 },
        { date: "2026-11-11", commandes: 13, ventes: 53000 },
        // Bord d'un export : des commandes peuvent manquer, pas une alerte.
        { date: "2026-11-12", commandes: 7, ventes: 30000, partiel: true },
      ],
      today: "2026-11-13",
      depuis: "2026-11-01",
    });
    expect(b.liste.map((x) => [x.type, x.jour])).toEqual([["uber_jour", "2026-11-11"]]);
    expect(b.liste[0].detail).toContain("13 commande(s) chez Uber, 12 en caisse");
  });

  it("Uber de la semaine : versement annoncé absent du compte", () => {
    const jours = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"];
    const cash = jours.map((d) => jour(d, 10000, { uber: 10000 }));
    const bank = [
      ...jours.map((d, i) => remise(d === "2026-11-02" ? "2026-11-03" : jours[i + 1] ?? "2026-11-09", 10000)),
      debut,
    ];
    const versementsUber = [{ id: "v1", date: "2026-11-10", montant: 52500, brut: 70000, debut: "2026-11-02", fin: "2026-11-08" }];
    const b = listerIncoherences({ cash, bank, versementsUber, uberJours: [], today: "2026-11-20", depuis: "2026-11-01" });
    expect(b.liste.filter((x) => x.type.startsWith("uber")).map((x) => x.type)).toEqual(["uber_banque"]);
    // Avec le virement Uber sur le compte : plus rien côté Uber.
    const avec = listerIncoherences({
      cash,
      bank: [...bank, { id: "u", date: "2026-11-11", amount: 52500, libelle: "VIR UBER EATS" }],
      versementsUber,
      uberJours: [],
      today: "2026-11-20",
      depuis: "2026-11-01",
    });
    expect(avec.liste.filter((x) => x.type.startsWith("uber"))).toEqual([]);
  });

  it("liste triée de la plus récente à la plus ancienne", () => {
    const paiements = [{ libelle: "CB", montant: 50000, categorie: "cb" }];
    const cash = ["2026-11-03", "2026-11-09", "2026-11-05"].map((d) => jour(d, 0, { paiements, total: 1 }));
    expect(base(cash, []).liste.map((x) => x.date)).toEqual(["2026-11-09", "2026-11-05", "2026-11-03"]);
  });
});
