import { isCashDeposit, isUber } from "./cashImport";
import { daysBetween, formatEuros } from "./money";
import { JAMAIS_FOURNISSEUR, debitDuFournisseur, lireDebit, normTexte, rapprocher, type Debit } from "./rapprochementFournisseurs";
import { reconcileDeposits, type BankLine, type CashLine } from "./reconcile";
import { estVirementTitres, pointageMoisCB, semaineUber, suiviTitres, type ComparaisonCB, type VersementUber } from "./ticketZ";
import type { BankTransaction, Invoice, Supplier, WithId } from "./types";

/**
 * Relevé de compte justifié ligne par ligne (demande du gérant, 19/11/2026) : pour chaque opération du relevé
 * bancaire, la pièce qui l'explique (facture fournisseur, journée de caisse, versement Uber Eats, virement d'un
 * émetteur de titres-restaurant, dépôt d'espèces…) ou « non justifiée ». Le gérant revoit ensuite chaque ligne à l'œil.
 *
 * Aucune règle nouvelle : on réutilise les rapprochements déjà en place (factures ↔ banque au centime, CB du ticket Z
 * ↔ remises CB par jour de crédit, récap Uber ↔ virement Uber, dépôts d'espèces ↔ journées de caisse consécutives).
 */

export type StatutLigne =
  /** Une pièce de l'app correspond (facture, journée de caisse, récap Uber…). */
  | "justifie"
  /** Nature connue sans pièce dans l'app (frais bancaires, URSSAF, salaire). */
  | "explique"
  /** Peut encore se régler tout seul (remises du jour pas toutes créditées, ticket Z pas encore relevé). */
  | "attente"
  /** Une pièce existe mais ne colle pas (écart CB, débit d'un fournisseur sans facture). */
  | "anomalie"
  | "non_justifie";

export const ORDRE_STATUTS: StatutLigne[] = ["non_justifie", "anomalie", "attente", "explique", "justifie"];

export interface FactureLiee {
  id: string;
  numero: string;
  fournisseur: string;
  date: string;
  ttc: number;
}

export interface LigneJustifiee {
  id: string;
  date: string;
  libelle: string;
  montant: number; // centimes, positif = crédit
  /** Nature lue au relevé : « Remise CB », « Fournisseur », « Uber Eats »… */
  nature: string;
  statut: StatutLigne;
  /** La justification, en une ou deux phrases. */
  texte: string;
  factures?: FactureLiee[];
  /** Crédit CB : clé du groupe (jour de crédit) dans groupesCB. */
  cb?: string;
  /** Lien dans l'app vers la preuve (journée de caisse, onglet Factures). */
  lien?: string;
}

export interface GroupeCB {
  credit: string;
  remises: number;
  banque: number;
  caisse: number;
  ecart: number;
  titres?: number;
  jours: { date: string; montant: number }[];
}

export interface ReleveJustifie {
  lignes: LigneJustifiee[];
  groupesCB: Record<string, GroupeCB>;
}

export interface EntreeCaisseReleve {
  id: string;
  date: string;
  cb: number;
  especes?: number;
  uber?: number;
}

export interface DonneesReleve {
  bank: WithId<BankTransaction>[];
  invoices: WithId<Invoice>[];
  suppliers: WithId<Supplier>[];
  cash: EntreeCaisseReleve[];
  versementsUber: VersementUber[];
  /** Salariés (nom, prénom) : un virement à leur nom est un salaire ou un acompte. */
  employes?: { nom: string; prenom: string }[];
  /** Bénéficiaires marqués « pas un fournisseur » dans Factures > Banque depuis janvier. */
  horsFournisseurs?: string[];
  /** AAAA-MM-JJ, heure de Paris. */
  today: string;
}

const fr = (iso: string) => iso.split("-").reverse().join("/");
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const NOMS_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const nomMois = (m: string) => `${NOMS_MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const ajoutMois = (mois: string, n: number) => {
  const [y, m] = mois.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 && !mot.endsWith("s") ? "s" : ""}`;
/** Écart CB (centimes) qui n'est qu'un arrondi. */
const TOLERANCE_ARRONDI = 500;

const EMETTEURS: [RegExp, string][] = [
  [/EDENRED|TICKET\s*REST/i, "Edenred"],
  [/PLUXEE|SODEXO/i, "Pluxee"],
  [/BIMPLI|APETIZ/i, "Bimpli"],
  [/SWILE/i, "Swile"],
  [/UP\s*DEJ|CHEQUE\s*DEJ/i, "Up Déjeuner"],
  [/CONECS/i, "Conecs (titres dématérialisés)"],
  [/TRD/i, "titres-restaurant (TRD)"],
];
export const emetteurTitres = (libelle: string) => EMETTEURS.find(([r]) => r.test(libelle))?.[1] ?? "un émetteur de titres-restaurant";

const facturesLiees = (ids: string[], parId: Map<string, WithId<Invoice>>): FactureLiee[] =>
  ids
    .map((id) => parId.get(id))
    .filter((f): f is WithId<Invoice> => !!f)
    .sort((a, b) => a.dateFacture.localeCompare(b.dateFacture))
    .map((f) => ({ id: f.id, numero: f.numero, fournisseur: f.supplierNom, date: f.dateFacture, ttc: f.montantTTC }));

const moisDes = (fs: FactureLiee[]) => {
  const m = [...new Set(fs.map((f) => f.date.slice(0, 7)))].sort();
  return m.length ? m.map(nomMois).join(", ") : "";
};

export function justifierReleve(d: DonneesReleve): ReleveJustifie {
  const { today } = d;
  const lignes = [...d.bank].filter((t) => t.montant !== 0).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  if (!lignes.length) return { lignes: [], groupesCB: {} };
  const debutBanque = lignes[0].date;
  const finBanque = lignes[lignes.length - 1].date;
  const parFacture = new Map(d.invoices.map((f) => [f.id, f]));
  const out = new Map<string, LigneJustifiee>();
  const poser = (t: WithId<BankTransaction>, l: Omit<LigneJustifiee, "id" | "date" | "libelle" | "montant">) =>
    out.set(t.id, { id: t.id, date: t.date, libelle: t.libelle ?? "", montant: t.montant, ...l });

  const bankLines: BankLine[] = lignes.map((t) => ({ id: t.id, date: t.date, amount: t.montant, libelle: t.libelle ?? "", ...(t.valeur ? { valeur: t.valeur } : {}) }));
  const parLigne = new Map(lignes.map((t) => [t.id, t]));

  // ---------------------------------------------------------------- Crédits
  // 1. Remises CB : même règle que « Jour à jour » (toutes les remises d'un jour de crédit contre les journées couvertes).
  const groupesCB: Record<string, GroupeCB> = {};
  const cbCaisse: CashLine[] = d.cash.map((c) => ({ id: c.id, date: c.date, amount: c.cb }));
  const credits = bankLines.filter((b) => b.amount > 0 && !isCashDeposit(b.libelle) && !isUber(b.libelle));
  const premierJourCaisse = cbCaisse.reduce((m, c) => (c.amount > 0 && c.date < m ? c.date : m), "9999-12-31");
  const options = { maxDays: 5, maxFeeRate: 0.03, today, lignes: bankLines };
  const vus = new Set<string>();
  const tous: ComparaisonCB[] = [];
  for (let mois = debutBanque.slice(0, 7); mois <= today.slice(0, 7); mois = ajoutMois(mois, 1)) {
    const p = pointageMoisCB(mois, cbCaisse, credits, options);
    for (const g of p.groupes) {
      if (!g.banque || !g.remises?.length || vus.has(g.banque.date)) continue;
      vus.add(g.banque.date);
      tous.push(g);
    }
    for (const b of p.remisesSeules) {
      const t = parLigne.get(b.id);
      if (!t || out.has(b.id)) continue;
      const recente = daysBetween(b.date, today) <= 2;
      poser(t, {
        nature: "Remise CB",
        statut: recente ? "attente" : "non_justifie",
        texte: recente
          ? "Remise CB : le ticket Z de la journée n'est pas encore relevé."
          : b.date <= premierJourCaisse
            ? "Remise CB d'avant la première journée de caisse enregistrée : rien à comparer."
            : "Remise CB rattachée à aucune journée de caisse (ticket Z manquant ?).",
        lien: `/rapprochement?jour=${addDays(b.date, -1)}`,
      });
    }
  }
  tous.sort((x, y) => x.banque!.date.localeCompare(y.banque!.date));
  const ecartDe = (g: ComparaisonCB) => g.ecart ?? g.banque!.montant - g.caisse;
  // Lot crédité un jour plus tard : un manque sur un crédit et un excédent sur le crédit voisin qui s'annulent
  // (constaté sur les vraies données : 12-13/08, 31/08-01/09, 18-19/09).
  const compense = new Map<string, string>();
  for (let i = 0; i + 1 < tous.length; i++) {
    const [x, y] = [ecartDe(tous[i]), ecartDe(tous[i + 1])];
    if (Math.sign(x) === Math.sign(y) || Math.min(Math.abs(x), Math.abs(y)) <= TOLERANCE_ARRONDI) continue;
    if (statutCB(tous[i], tous[i].banque!.date, finBanque, today) !== "anomalie" && statutCB(tous[i + 1], tous[i + 1].banque!.date, finBanque, today) !== "anomalie") continue;
    if (Math.abs(x + y) <= Math.max(30000, 0.25 * Math.min(Math.abs(x), Math.abs(y)))) {
      compense.set(tous[i].banque!.date, tous[i + 1].banque!.date);
      compense.set(tous[i + 1].banque!.date, tous[i].banque!.date);
      i++;
    }
  }
  for (const g of tous) {
    const cle = g.banque!.date;
    const ecart = ecartDe(g);
    groupesCB[cle] = {
      credit: cle,
      remises: g.remises!.length,
      banque: g.banque!.montant,
      caisse: g.caisse,
      ecart,
      ...(g.titres ? { titres: g.titres } : {}),
      jours: (g.joursCouverts ?? []).map((j) => ({ date: j.date, montant: j.amount })),
    };
    let statut = statutCB(g, cle, finBanque, today);
    const voisin = compense.get(cle);
    const premierCredit = cle === debutBanque || (g.joursCouverts ?? []).some((j) => daysBetween(j.date, debutBanque) > 1);
    let explication: string;
    if (statut === "anomalie" && Math.abs(ecart) <= TOLERANCE_ARRONDI) {
      statut = "justifie";
      explication = `écart de ${formatEuros(ecart)} (arrondi)`;
    } else if (statut === "anomalie" && voisin) {
      statut = "justifie";
      const autre = ecartDe(tous.find((x) => x.banque!.date === voisin)!);
      explication = `écart de ${formatEuros(ecart)} compensé par le crédit du ${fr(voisin)} (${formatEuros(autre)}) : un lot de remises crédité un jour plus tard, reste ${formatEuros(ecart + autre)} sur les deux jours`;
    } else if (statut === "anomalie" && premierCredit) {
      statut = "explique";
      explication = `premier crédit du relevé bancaire : les remises des journées précédentes ont été créditées avant le début du relevé (${fr(debutBanque)}), impossible de comparer`;
    } else if (statut === "justifie") {
      explication = g.titres
        ? `écart de ${formatEuros(ecart)} = tickets-resto passés « CB » en caisse, payés à part par les émetteurs`
        : g.voisin || g.remiseExacte
          ? "un lot de remises est passé sur le crédit voisin, les deux écarts se compensent"
          : Math.abs(ecart) <= 100
            ? "à 1 € près"
            : `écart de ${formatEuros(ecart)}`;
    } else {
      explication = statut === "attente" ? "le reste des remises peut encore arriver" : `écart de ${formatEuros(ecart)} non expliqué`;
    }
    const jours = (g.joursCouverts ?? []).map((j) => fr(j.date));
    const journees = jours.length > 1 ? `journées du ${jours.join(", ")}` : `journée du ${jours[0] ?? "?"}`;
    g.remises!.forEach((b, i) => {
      const t = parLigne.get(b.id);
      if (!t) return;
      poser(t, {
        nature: "Remise CB",
        statut,
        texte: `Remise ${i + 1} sur ${g.remises!.length} créditées le ${fr(cle)} : ensemble ${formatEuros(g.banque!.montant)} pour ${formatEuros(g.caisse)} de CB au ticket Z (${journees}) — ${explication}.`,
        cb: cle,
        ...(g.joursCouverts?.[0] ? { lien: `/rapprochement?jour=${g.joursCouverts[0].date}` } : {}),
      });
    });
  }

  // 2. Virements Uber Eats : le net annoncé par le récap Uber (mail du lundi) arrive tel quel, entre J-2 et J+5.
  const versementsPris = new Set<string>();
  for (const t of lignes.filter((x) => x.montant > 0 && isUber(x.libelle ?? ""))) {
    const v = d.versementsUber
      .filter((x) => !versementsPris.has(x.id) && Math.abs(x.montant - t.montant) <= 1)
      .map((x) => ({ x, j: daysBetween(x.date, t.date) }))
      .filter(({ j }) => j >= -2 && j <= 5)
      .sort((a, b) => Math.abs(a.j) - Math.abs(b.j))[0]?.x;
    if (v) {
      versementsPris.add(v.id);
      const periode = v.debut && v.fin ? ` (ventes du ${fr(v.debut)} au ${fr(v.fin)})` : "";
      const detail = [v.brut !== undefined ? `ventes ${formatEuros(v.brut)}` : "", v.frais !== undefined ? `frais Uber ${formatEuros(v.frais)}` : ""].filter(Boolean).join(", ");
      poser(t, {
        nature: "Uber Eats",
        statut: "justifie",
        texte: `Versement Uber Eats du ${fr(v.date)}${periode} : net annoncé ${formatEuros(v.montant)} par le récap Uber${detail ? ` (${detail})` : ""}.`,
        ...(v.debut ? { lien: `/rapprochement?jour=${v.debut}` } : {}),
      });
      continue;
    }
    // « VIR SEPA STICHTING CUSTODIAN UB POP SVCS, DOB , 20260803 - … » : la date est le lundi de la semaine payée.
    const lu = /\b(20\d{2})(\d{2})(\d{2})\b/.exec(t.libelle ?? "");
    const s = lu ? semaineUber(`${lu[1]}-${lu[2]}-${lu[3]}`) : semaineUber(addDays(t.date, -7));
    const z = d.cash.filter((c) => c.date >= s.debut && c.date <= s.fin).reduce((x, c) => x + (c.uber ?? 0), 0);
    poser(t, {
      nature: "Uber Eats",
      statut: "explique",
      texte: `Virement Uber Eats pour la semaine du ${fr(s.debut)} au ${fr(s.fin)}, sans récap Uber enregistré pour le comparer au centime. Uber dans les tickets Z de cette semaine : ${formatEuros(z)}${z > 0 ? `, soit ${Math.round((t.montant / z) * 100)} % versés après commission Uber` : ""}.`,
      lien: `/rapprochement?jour=${s.debut}`,
    });
  }

  // 3. Titres-restaurant : cartes passées « CB » en caisse, payées à part et en retard par les émetteurs (contrôle en cumul).
  const cumulTitres = new Map<string, ReturnType<typeof suiviTitres>["cumul"]>();
  for (const t of lignes.filter((x) => x.montant > 0 && estVirementTitres(x.libelle ?? "") && !out.has(x.id))) {
    const mois = t.date.slice(0, 7);
    if (!cumulTitres.has(mois)) cumulTitres.set(mois, suiviTitres(mois, cbCaisse, credits, options).cumul);
    const c = cumulTitres.get(mois)!;
    poser(t, {
      nature: "Titres-restaurant",
      statut: "justifie",
      texte: `Virement de ${emetteurTitres(t.libelle ?? "")} : titres-restaurant encaissés en carte et saisis « CB » en caisse, payés à part par l'émetteur. Depuis le ${fr(c.depuis)}, ${formatEuros(c.passes)} de titres passés en CB et ${formatEuros(c.recus)} reçus des émetteurs (fin ${nomMois(mois)}).`,
    });
  }

  // 4. Dépôts d'espèces : une suite de journées de caisse consécutives qui fait le montant au centime.
  const depots = bankLines.filter((b) => b.amount > 0 && isCashDeposit(b.libelle) && !out.has(b.id));
  if (depots.length) {
    const especes: CashLine[] = d.cash.map((c) => ({ id: c.id, date: c.date, amount: c.especes ?? 0 }));
    const r = reconcileDeposits(especes, depots, { maxDays: 21, tolerance: 0 });
    for (const m of r.matches) {
      const t = parLigne.get(m.deposit.id)!;
      const j = m.days.map((x) => fr(x.date));
      poser(t, {
        nature: "Dépôt d'espèces",
        statut: "justifie",
        texte: `Espèces des ${pluriel(j.length, "journée")} de caisse ${j.length > 1 ? `du ${j[0]} au ${j[j.length - 1]}` : `du ${j[0]}`} : ${formatEuros(m.days.reduce((s, x) => s + x.amount, 0))} au ticket Z.`,
        lien: `/rapprochement?jour=${m.days[0].date}`,
      });
    }
    // Dépôts en montants ronds (« DPT VRAC ESP », 5 000 €) : contrôle en cumul, le déposé ne peut pas dépasser les
    // espèces encaissées au ticket Z depuis le début du relevé.
    const depuis = addDays(debutBanque, -21);
    const tri = [...depots].sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
    let depose = 0;
    const cumul = new Map<string, number>();
    for (const b of tri) cumul.set(b.id, (depose += b.amount));
    for (const b of r.unmatchedDeposits) {
      const caisse = especes.filter((c) => c.date >= depuis && c.date <= b.date).reduce((x, c) => x + c.amount, 0);
      const deja = cumul.get(b.id)!;
      const ok = caisse > 0 && deja <= caisse;
      poser(parLigne.get(b.id)!, {
        nature: "Dépôt d'espèces",
        statut: ok ? "justifie" : caisse > 0 ? "anomalie" : "non_justifie",
        texte: caisse
          ? `Dépôt d'espèces. Du ${fr(depuis)} au ${fr(b.date)} : ${formatEuros(caisse)} d'espèces au ticket Z, ${formatEuros(deja)} déposés en banque (celui-ci compris)${ok ? ", le dépôt est couvert par la caisse" : " : plus d'espèces déposées que encaissées"}.`
          : "Dépôt d'espèces : aucune journée de caisse avec des espèces avant ce dépôt.",
        lien: `/rapprochement?jour=${b.date}`,
      });
    }
  }

  // 5. Autres crédits : remboursement d'un fournisseur, sinon à justifier.
  for (const t of lignes.filter((x) => x.montant > 0 && !out.has(x.id))) {
    const deb = lireDebit({ ...t, montant: -t.montant });
    const lib = normTexte(t.libelle ?? "");
    if (/STRIPE|DISHOP/.test(lib)) {
      poser(t, { nature: "Ventes en ligne", statut: "explique", texte: "Versement Stripe des commandes en ligne (site Dishop) : le détail est dans l'espace Dishop / Stripe." });
      continue;
    }
    const s = d.suppliers.find((x) => debitDuFournisseur(deb, x));
    if (!s && /\b(INV|AVOIR|REMB|REMBOURSEMENT|RBT)\b/.test(lib)) {
      poser(t, { nature: "Remboursement", statut: "explique", texte: `Remboursement ou avoir${deb.tiers ? ` de ${deb.tiers.replace(/ INV.*$/, "")}` : ""} (référence de facture dans le libellé).` });
      continue;
    }
    poser(t, {
      nature: "Crédit",
      statut: s ? "explique" : "non_justifie",
      texte: s
        ? `Virement reçu de ${s.nom} (fournisseur) : remboursement ou avoir, à rapprocher de son avoir.`
        : `Crédit${deb.tiers ? ` de ${deb.tiers}` : ""} : aucune pièce dans l'app (ni caisse, ni Uber, ni titres-restaurant).`,
    });
  }

  // ---------------------------------------------------------------- Débits
  const r = rapprocher(d.suppliers, d.invoices, d.bank, { depuis: debutBanque.slice(0, 7), aujourdhui: today, horsFournisseurs: d.horsFournisseurs });
  const lies = new Set<string>(); // factures déjà rattachées à un débit
  for (const b of r.fournisseurs) for (const p of b.paiements) p.factures.forEach((id) => lies.add(id));

  // Paiements individuels (prélèvement, LCR, virement au nom du fournisseur).
  for (const b of r.fournisseurs) {
    for (const p of b.paiements) {
      if (p.type === "remise") continue;
      const t = parLigne.get(p.debitId);
      if (!t) continue;
      const fs = facturesLiees(p.factures, parFacture);
      const mode = p.type === "prelevement" ? "Prélèvement" : p.type === "carte" ? "Paiement carte" : "Virement";
      poser(t, fs.length
        ? {
            nature: "Fournisseur",
            statut: "justifie",
            texte: `${mode} ${b.nom} : ${fs.length > 1 ? `${fs.length} factures (${moisDes(fs)}) qui font` : "facture de"} ${formatEuros(p.montant)} au centime.`,
            factures: fs,
          }
        : {
            nature: "Fournisseur",
            statut: "anomalie",
            texte: `${mode} ${b.nom} : aucune facture de ce montant dans l'app. Facture manquante (à réclamer) ou pas encore reçue.`,
            lien: "/factures?vue=banque",
          });
    }
  }

  // Remises de virements groupés : composées au centime de totaux mensuels de fournisseurs payés par virement.
  for (const x of r.remises) {
    const t = parLigne.get(x.debit.id);
    if (!t) continue;
    if (!x.groupes) {
      poser(t, {
        nature: "Virements groupés",
        statut: "non_justifie",
        texte: "Remise de virements groupés (le relevé ne donne pas les bénéficiaires) : aucune combinaison de factures fournisseurs ne fait ce montant au centime. Salaires, ou factures absentes de l'app ?",
        lien: "/factures?vue=banque",
      });
      continue;
    }
    const ids = r.fournisseurs.flatMap((b) => b.paiements.filter((p) => p.debitId === x.debit.id).flatMap((p) => p.factures));
    poser(t, {
      nature: "Virements groupés",
      statut: "justifie",
      texte: `Remise de ${pluriel(x.groupes.length, "virement")} : ${x.groupes.map((g) => `${g.nom} (${nomMois(g.mois)}) ${formatEuros(g.montant)}`).join(", ")}. Total au centime.`,
      factures: facturesLiees(ids, parFacture),
    });
  }

  // Le reste des débits.
  const hors = new Set((d.horsFournisseurs ?? []).map(normTexte));
  const sansFiche = new Map(r.sansFournisseur.flatMap((s) => s.debits.map((x) => [x.id, s] as const)));
  const employes = (d.employes ?? []).map((e) => ({ nom: normTexte(e.nom), prenom: normTexte(e.prenom), affiche: `${e.prenom} ${e.nom}`.trim() })).filter((e) => e.nom.length >= 2);
  const libres = d.invoices.filter((f) => !lies.has(f.id) && f.montantTTC > 0);
  for (const t of lignes.filter((x) => x.montant < 0 && !out.has(x.id))) {
    const deb: Debit = lireDebit(t);
    const lib = normTexte(t.libelle ?? "");
    if (deb.type === "frais") {
      poser(t, { nature: "Frais bancaires", statut: "explique", texte: "Frais de la banque (commission sur les remises CB, tenue de compte, cotisation carte) : la pièce est le relevé lui-même." });
      continue;
    }
    if (JAMAIS_FOURNISSEUR.test(lib)) {
      const qui = /URSSAF/.test(lib) ? "URSSAF" : /DGFIP|DIRECTION GENERALE|IMPOTS|TRESOR/.test(lib) ? "impôts (DGFiP)" : /AMERICAN EXPRESS/.test(lib) ? "American Express" : "caisse de retraite / prévoyance";
      poser(t, { nature: "Impôts et social", statut: "explique", texte: `Paiement ${qui} : pas de facture fournisseur, le justificatif est l'avis ou la déclaration de l'organisme.` });
      continue;
    }
    const salarie = deb.type === "virement" ? employes.find((e) => lib.includes(e.nom) && (!e.prenom || lib.includes(e.prenom))) : undefined;
    if (salarie) {
      poser(t, { nature: "Salaire", statut: "explique", texte: `Virement à ${salarie.affiche} (salarié) : salaire ou acompte, justifié par la fiche de paie.` });
      continue;
    }
    // Facture du même montant au centime, pas encore rattachée (paiement carte, chèque, virement au libellé illisible).
    const montant = -t.montant;
    const f = libres
      .filter((x) => x.montantTTC === montant && daysBetween(x.dateFacture, t.date) >= -7 && daysBetween(x.dateFacture, t.date) <= 75)
      .sort((a, b) => Math.abs(daysBetween(a.dateFacture, t.date)) - Math.abs(daysBetween(b.dateFacture, t.date)))[0];
    if (f) {
      libres.splice(libres.indexOf(f), 1);
      poser(t, {
        nature: deb.type === "cheque" ? "Chèque" : deb.type === "carte" ? "Paiement carte" : "Fournisseur",
        statut: "justifie",
        texte: `Même montant, au centime, qu'une facture ${f.supplierNom} du ${fr(f.dateFacture)} pas encore rattachée à un paiement.`,
        factures: facturesLiees([f.id], parFacture),
      });
      continue;
    }
    if (/TOT DIF/.test(lib)) {
      poser(t, { nature: "Carte bancaire", statut: "explique", texte: "Total du mois de la carte à débit différé : le détail des achats est sur le relevé de la carte (onglet carte de la banque)." });
      continue;
    }
    if (deb.tiers && hors.has(deb.tiers)) {
      poser(t, { nature: "Autre", statut: "explique", texte: `${deb.tiers} : marqué « pas un fournisseur » dans Factures.` });
      continue;
    }
    const s = sansFiche.get(t.id);
    if (s) {
      poser(t, {
        nature: s.type === "prelevement" ? "Prélèvement" : "Virement",
        statut: "non_justifie",
        texte: `${s.type === "prelevement" ? "Prélèvement" : "Virement"} ${s.tiers} (${pluriel(s.nombre, "fois")} depuis le ${fr(s.premier)}) : aucune fiche fournisseur ni facture. Rattache-le à un fournisseur dans Factures, ou marque-le « pas un fournisseur ».`,
        lien: "/factures?vue=banque",
      });
      continue;
    }
    const nature = { cheque: "Chèque", carte: "Paiement carte", prelevement: "Prélèvement", virement: "Virement", remise: "Virements groupés", frais: "Frais bancaires", autre: "Débit" }[deb.type];
    poser(t, {
      nature,
      statut: "non_justifie",
      texte: `${nature}${deb.tiers ? ` ${deb.tiers}` : ""} : aucune facture ni pièce de ce montant dans l'app.`,
    });
  }

  return { lignes: lignes.map((t) => out.get(t.id)!).filter(Boolean), groupesCB };
}

function statutCB(g: ComparaisonCB, credit: string, finBanque: string, today: string): StatutLigne {
  if (g.statut === "ok" || g.statut === "proche") return "justifie";
  // Crédit le plus récent encore en manque : les remises arrivent parfois en plusieurs fois.
  if ((g.ecart ?? 0) < 0 && credit >= finBanque && daysBetween(credit, today) <= 3) return "attente";
  if (g.statut === "attente") return "attente";
  return "anomalie";
}

export interface ResumeMois {
  mois: string;
  lignes: number;
  credits: number; // centimes
  debits: number; // centimes (positif)
  statuts: Record<StatutLigne, number>;
}

export function resumerMois(mois: string, lignes: LigneJustifiee[]): ResumeMois {
  const statuts = { justifie: 0, explique: 0, attente: 0, anomalie: 0, non_justifie: 0 } as Record<StatutLigne, number>;
  let credits = 0;
  let debits = 0;
  for (const l of lignes) {
    statuts[l.statut]++;
    if (l.montant > 0) credits += l.montant;
    else debits -= l.montant;
  }
  return { mois, lignes: lignes.length, credits, debits, statuts };
}
