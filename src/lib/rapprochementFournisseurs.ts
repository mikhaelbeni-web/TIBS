import type { BankTransaction, Invoice, ModePaiement, Supplier, WithId } from "./types";

/**
 * Rapprochement factures fournisseurs ↔ relevé bancaire, mois par mois depuis janvier.
 *
 * Ce que montre le relevé (Caisse d'Épargne, constaté sur les vraies données) :
 * - prélèvements et LCR au nom du fournisseur (« PRLV METRO FRANCE… », « LCR 925444 RLV … LPB ») ;
 * - quelques virements individuels (« VIR SEPA HPS Virement vers HPS », « VIR INST … ») ;
 * - surtout des remises de virements groupés (« REM VIR SEPA DU 16/09/26 … ») : un seul débit, sans le nom
 *   des bénéficiaires. Une remise est expliquée quand des totaux mensuels de fournisseurs la composent au centime.
 *
 * Tout est déduit du montant exact : une facture (ou un mois de factures) n'est « payée » que si un débit
 * lui correspond au centime près. Un débit au nom d'un fournisseur qui ne correspond à rien = factures manquantes.
 */

export type TypeDebit = "prelevement" | "virement" | "remise" | "cheque" | "carte" | "frais" | "autre";

export interface Debit {
  id: string;
  date: string;
  montant: number; // centimes, positif
  libelle: string;
  type: TypeDebit;
  /** Bénéficiaire lu dans le libellé (« METRO FRANCE », « HPS »), en majuscules sans accents. */
  tiers: string;
}

export const normTexte = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

/** Nature du débit et bénéficiaire, d'après le libellé du relevé. */
export function lireDebit(t: Pick<WithId<BankTransaction>, "id" | "date" | "montant" | "libelle">): Debit {
  const brut = t.libelle ?? "";
  const l = normTexte(brut);
  const base = { id: t.id, date: t.date, montant: -t.montant, libelle: brut };
  if (/^REM VIR/.test(l)) return { ...base, type: "remise", tiers: "" };
  if (/^(CB COM|COMMISSIONS?|FRAIS|COTIS|\d+ MVT|REGUL|INTERETS|AGIOS)/.test(l) || /^\*/.test(brut.trim())) return { ...base, type: "frais", tiers: "" };
  if (/^CHEQUE/.test(l)) return { ...base, type: "cheque", tiers: "" };
  let m = /^PRLV (?:SEPA )?(.+?)(?: \d{6,}\w*| [A-Z0-9]*\d{6,}[A-Z0-9]*)*$/.exec(l);
  if (m) return { ...base, type: "prelevement", tiers: nettoyerTiers(m[1]) };
  m = /^LCR \d+ RLV \d+ (.+)$/.exec(l);
  if (m) return { ...base, type: "prelevement", tiers: nettoyerTiers(m[1]) };
  m = /^VIR (?:SEPA|INST)(?: EMIS)? (.+?)(?: VIREMENT VERS .*)?$/.exec(l);
  if (m) return { ...base, type: "virement", tiers: nettoyerTiers(m[1]) };
  if (/^(CB|CARTE|PAIEMENT CB) /.test(l)) return { ...base, type: "carte", tiers: nettoyerTiers(l.replace(/^(PAIEMENT CB|CARTE|CB) (\d{4} ?\d* ?)?/, "")) };
  return { ...base, type: "autre", tiers: nettoyerTiers(l) };
}

/** « METRO FRANCE S A S METRO F 2621822G10508585 » → « METRO FRANCE » ; références et formes juridiques retirées. */
function nettoyerTiers(s: string): string {
  const mots = s.split(" ").filter((w) => w && !/\d{4,}/.test(w) && !FORMES.has(w));
  const out: string[] = [];
  for (const w of mots) {
    if (out.includes(w)) break; // « METRO FRANCE S A S METRO F » : la répétition marque la fin du nom
    out.push(w);
    if (out.length >= 4) break;
  }
  return out.join(" ");
}

const FORMES = new Set(["S", "A", "SA", "SAS", "SASU", "SARL", "EURL", "SNC", "STE", "SOCIETE", "ETS", "LES", "DES", "DE", "DU", "LA", "LE", "ET", "F"]);
/** Mots trop courants pour identifier un fournisseur (dans un nom ou un libellé). */
const GENERIQUES = new Set([
  "FRANCE", "PARIS", "DISTRIBUTION", "DISTRIB", "GROUPE", "SERVICE", "SERVICES", "COMPTA", "FACTURE", "NOUVEAU", "CLIENT", "SUD", "NORD", "EST", "OUEST",
  "DIRECTION", "GENERALE", "VIREMENT", "VERS", "INTERNATIONAL", "MARKETING", "ENTREPRISE", "DIVISION", "COMPAGNIE", "CAPITAL", "COM", "FR", "MR", "MME",
]);

const motsDistinctifs = (s: string) => normTexte(s).split(" ").filter((w) => w.length >= 3 && !GENERIQUES.has(w) && !FORMES.has(w));

/**
 * Le débit désigne-t-il ce fournisseur ? Un des mots du réglage « libellé bancaire » de la fiche, ou un mot distinctif commun au bénéficiaire et au nom du fournisseur, ou le début du domaine de son e-mail
 * (« HPS » ↔ comptabilite@hpsrungis.com).
 */
export function debitDuFournisseur(d: Debit, s: Pick<Supplier, "nom" | "email" | "libelleBanque">): boolean {
  if (!d.tiers) return false;
  const lib = normTexte(d.libelle);
  if (
    s.libelleBanque
      ?.split(/[,;\n]/)
      .map(normTexte)
      .filter(Boolean)
      .some((m) => lib.includes(m))
  )
    return true;
  const tiers = motsDistinctifs(d.tiers);
  const nom = motsDistinctifs(s.nom);
  const collé = normTexte(s.nom).replace(/ /g, "");
  const domaine = (s.email ?? "").split("@")[1]?.split(".")[0]?.toUpperCase().replace(/[^A-Z0-9]/g, "") ?? "";
  const generique = /^(GMAIL|HOTMAIL|OUTLOOK|YAHOO|ORANGE|FREE|WANADOO|SFR|LAPOSTE|ICLOUD|INVOICING|NOTIFICATION|MAIL|AXONAUT|PENNYLANE|BREVOSEND)/.test(domaine);
  return tiers.some(
    (w) => nom.includes(w) || (w.length >= 3 && (collé.startsWith(w) || (!generique && domaine.length >= 3 && domaine.startsWith(w)))),
  );
}

// ---------------------------------------------------------------------------

export type EtatMois =
  | "paye" // toutes les factures retrouvées au relevé
  | "partiel" // une partie seulement
  | "a_payer" // échéance pas encore passée
  | "non_vu" // échéance passée, rien au relevé (ou payé dans une remise non expliquée)
  | "sans_banque" // mois avant le début du relevé : impossible à contrôler
  | "manquantes" // payé au relevé sans facture correspondante
  | "rien";

export interface LienPaiement {
  debitId: string;
  date: string;
  montant: number;
  type: TypeDebit;
  /** Factures couvertes par ce débit (vide = aucune facture correspondante : facture manquante). */
  factures: string[];
}

export interface MoisFournisseur {
  mois: string;
  facture: number; // TTC des factures du mois
  nbFactures: number;
  paye: number; // TTC des factures retrouvées au relevé
  sansFacture: number; // débits du fournisseur sans facture correspondante, rattachés à ce mois
  etat: EtatMois;
}

export interface BilanFournisseur {
  cle: string;
  nom: string;
  supplier?: WithId<Supplier>;
  /** Mode constaté au relevé (prélèvement/LCR, virement), sinon celui de la fiche. */
  mode: ModePaiement;
  modeConstate?: ModePaiement;
  mois: MoisFournisseur[];
  paiements: LienPaiement[];
  totalFacture: number;
  totalPaye: number;
  totalSansFacture: number;
}

export interface RemiseExpliquee {
  debit: Debit;
  /** Groupes (fournisseur, mois) qui composent la remise au centime, ou null si aucune combinaison. */
  groupes: { cle: string; nom: string; mois: string; montant: number }[] | null;
}

export interface TiersSansFournisseur {
  tiers: string;
  type: TypeDebit;
  nombre: number;
  total: number;
  premier: string;
  dernier: string;
  debits: Debit[];
}

export interface Rapprochement {
  depuis: string; // AAAA-MM
  jusqua: string; // AAAA-MM
  debutBanque?: string; // première opération du relevé (AAAA-MM-JJ)
  fournisseurs: BilanFournisseur[];
  remises: RemiseExpliquee[];
  /** Débits réguliers (prélèvements, virements) à des tiers sans fiche fournisseur : factures probablement absentes. */
  sansFournisseur: TiersSansFournisseur[];
  /** Factures payées selon le relevé mais encore « à payer » dans l'app. */
  aPointer: { factureId: string; date: string; mode: ModePaiement }[];
}

const TOL = 0; // les correspondances sont exactes, au centime

const ajoutMois = (mois: string, n: number) => {
  const [y, m] = mois.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};
const jours = (a: string, b: string) => (Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;

/** Combinaison de montants dont la somme vaut exactement `cible` (au centime), par rencontre au milieu. */
export function sommeExacte(montants: number[], cible: number, max = 26): number[] | null {
  const idx = montants.map((m, i) => [m, i] as const).filter(([m]) => m > 0 && m <= cible + TOL);
  if (!idx.length) return null;
  // Trop de candidats : on garde les plus gros (les petits montants se combinent dans tous les sens).
  const c = idx.sort((a, b) => b[0] - a[0]).slice(0, max);
  const moitie = Math.floor(c.length / 2);
  const enumerer = (part: (readonly [number, number])[]) => {
    const out: [number, number][] = []; // [somme, masque]
    for (let mask = 0; mask < 1 << part.length; mask++) {
      let s = 0;
      for (let j = 0; j < part.length; j++) if (mask & (1 << j)) s += part[j][0];
      if (s <= cible + TOL) out.push([s, mask]);
    }
    return out;
  };
  const A = enumerer(c.slice(0, moitie));
  const B = enumerer(c.slice(moitie)).sort((x, y) => x[0] - y[0]);
  let best: [number, number] | null = null;
  let bestTaille = Infinity;
  for (const [sa, ma] of A) {
    const reste = cible - sa;
    // Recherche dichotomique d'une somme = reste dans B.
    let lo = 0;
    let hi = B.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (Math.abs(B[mid][0] - reste) <= TOL) {
        const taille = bits(ma) + bits(B[mid][1]);
        if ((ma || B[mid][1]) && taille < bestTaille) {
          best = [ma, B[mid][1]];
          bestTaille = taille;
        }
        break;
      }
      if (B[mid][0] < reste) lo = mid + 1;
      else hi = mid - 1;
    }
  }
  if (!best) return null;
  const choisis: number[] = [];
  c.slice(0, moitie).forEach(([, i], j) => best![0] & (1 << j) && choisis.push(i));
  c.slice(moitie).forEach(([, i], j) => best![1] & (1 << j) && choisis.push(i));
  return choisis.sort((a, b) => a - b);
}
const bits = (n: number) => {
  let c = 0;
  for (; n; n &= n - 1) c++;
  return c;
};

export interface OptionsRapprochement {
  depuis: string; // AAAA-MM
  aujourdhui: string; // AAAA-MM-JJ
  /** Bénéficiaires marqués « pas un fournisseur » par le gérant (tiers normalisés). */
  horsFournisseurs?: string[];
}

/** Bénéficiaires qui ne sont jamais des fournisseurs (impôts, social, banque). */
const JAMAIS_FOURNISSEUR = /\b(URSSAF|DIRECTION GENERALE|DGFIP|IMPOTS|TRESOR PUBLIC|KLESIA|MALAKOFF|AG2R|HUMANIS|PREVOYANCE|POLE EMPLOI|FRANCE TRAVAIL|AMERICAN EXPRESS)\b/;

export function rapprocher(
  suppliers: WithId<Supplier>[],
  invoices: WithId<Invoice>[],
  banque: WithId<BankTransaction>[],
  opt: OptionsRapprochement,
): Rapprochement {
  const jusqua = opt.aujourdhui.slice(0, 7);
  const tousMois: string[] = [];
  for (let m = opt.depuis; m <= jusqua; m = ajoutMois(m, 1)) tousMois.push(m);
  const datesBanque = banque.map((t) => t.date).sort();
  const debutBanque = datesBanque[0];
  const debits = banque.filter((t) => t.montant < 0 && t.date >= `${opt.depuis}-01`).map(lireDebit);
  const factures = invoices.filter((f) => f.mois >= ajoutMois(opt.depuis, -2) && f.montantTTC !== 0);

  const byId = new Map(suppliers.map((s) => [s.id, s]));
  // Deux fiches au même nom (créées par le mail et à la main) : un seul fournisseur.
  const parNom = new Map<string, WithId<Supplier>>();
  for (const s of suppliers) if (!parNom.has(normTexte(s.nom))) parNom.set(normTexte(s.nom), s);

  // 1. Débits au nom d'un fournisseur (le plus précis gagne : réglage du libellé, puis nom).
  const parFournisseur = new Map<string, Debit[]>();
  const pris = new Set<string>();
  const ordre = [...suppliers].sort((a, b) => Number(Boolean(b.libelleBanque?.trim())) - Number(Boolean(a.libelleBanque?.trim())));
  for (const d of debits) {
    if (d.type === "remise" || d.type === "frais" || d.type === "cheque") continue;
    const trouve = ordre.find((x) => debitDuFournisseur(d, x));
    if (!trouve) continue;
    const s = parNom.get(normTexte(trouve.nom)) ?? trouve;
    pris.add(d.id);
    parFournisseur.set(s.id, [...(parFournisseur.get(s.id) ?? []), d]);
  }

  // 2. Factures groupées par fournisseur (fiche, sinon nom).
  const groupes = new Map<string, { nom: string; supplier?: WithId<Supplier>; factures: WithId<Invoice>[] }>();
  const ficheDe = (f: Pick<Invoice, "supplierId" | "supplierNom">) => {
    const s = byId.get(f.supplierId) ?? parNom.get(normTexte(f.supplierNom));
    return s ? parNom.get(normTexte(s.nom)) ?? s : undefined;
  };
  for (const f of factures) {
    const s = ficheDe(f);
    const cle = s ? s.id : `nom:${normTexte(f.supplierNom)}`;
    const g = groupes.get(cle) ?? { nom: s?.nom ?? f.supplierNom, supplier: s, factures: [] };
    g.factures.push(f);
    groupes.set(cle, g);
  }
  for (const id of parFournisseur.keys()) if (!groupes.has(id)) groupes.set(id, { nom: byId.get(id)!.nom, supplier: byId.get(id), factures: [] });

  const payees = new Map<string, { date: string; mode: ModePaiement }>(); // factureId → paiement
  const bilans: BilanFournisseur[] = [];

  for (const [cle, g] of groupes) {
    const ds = [...(parFournisseur.get(cle) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const prlv = ds.filter((d) => d.type === "prelevement").length;
    const modeConstate: ModePaiement | undefined = ds.length ? (prlv * 2 >= ds.length ? "prelevement" : "virement") : undefined;
    const mode = modeConstate ?? g.supplier?.paiement ?? "virement";
    const libres = new Set(g.factures.map((f) => f.id));
    const paiements: LienPaiement[] = [];
    const lier = (d: Debit, ids: string[]) => {
      for (const id of ids) {
        libres.delete(id);
        payees.set(id, { date: d.date, mode: d.type === "prelevement" ? "prelevement" : "virement" });
      }
      paiements.push({ debitId: d.id, date: d.date, montant: d.montant, type: d.type, factures: ids });
    };
    const candidates = (d: Debit) =>
      g.factures.filter((f) => libres.has(f.id) && jours(d.date, f.dateFacture) >= -7 && jours(d.date, f.dateFacture) <= 100);
    for (const d of ds) {
      const c = candidates(d);
      // a) une facture au centime (prélèvement par facture) ;
      const une = c.filter((f) => Math.abs(f.montantTTC - d.montant) <= TOL).sort((a, b) => Math.abs(jours(d.date, a.dateFacture)) - Math.abs(jours(d.date, b.dateFacture)))[0];
      if (une) {
        lier(d, [une.id]);
        continue;
      }
      // b) toutes les factures restantes d'un mois (virement du total mensuel) ;
      const parMois = new Map<string, WithId<Invoice>[]>();
      for (const f of c) parMois.set(f.mois, [...(parMois.get(f.mois) ?? []), f]);
      const mois = [...parMois.entries()].find(([, fs]) => Math.abs(fs.reduce((s, f) => s + f.montantTTC, 0) - d.montant) <= TOL);
      if (mois) {
        lier(d, mois[1].map((f) => f.id));
        continue;
      }
      // c) une combinaison de factures restantes (deux mois d'un coup, une facture réglée à part…).
      const combi = c.length <= 40 ? sommeExacte(c.map((f) => f.montantTTC), d.montant) : null;
      lier(d, combi ? combi.map((i) => c[i].id) : []);
    }

    const moisDuDebit = (p: LienPaiement) => (mode === "virement" && Number(p.date.slice(8)) <= 25 ? ajoutMois(p.date.slice(0, 7), -1) : p.date.slice(0, 7));
    const lignes: MoisFournisseur[] = tousMois.map((m) => {
      const fs = g.factures.filter((f) => f.mois === m);
      const facture = fs.reduce((s, f) => s + f.montantTTC, 0);
      const paye = fs.filter((f) => !libres.has(f.id)).reduce((s, f) => s + f.montantTTC, 0);
      const sansFacture = paiements.filter((p) => !p.factures.length && moisDuDebit(p) === m).reduce((s, p) => s + p.montant, 0);
      const echeance = mode === "virement" ? `${ajoutMois(m, 1)}-15` : `${ajoutMois(m, 1)}-28`;
      const finControle = `${ajoutMois(m, 3)}-01`; // un paiement de ce mois peut passer jusqu'à deux mois plus tard
      let etat: EtatMois;
      if (sansFacture > 0) etat = "manquantes";
      else if (!fs.length) etat = "rien";
      else if (paye >= facture - TOL && fs.every((f) => !libres.has(f.id))) etat = "paye";
      else if (paye > 0) etat = "partiel";
      else if (opt.aujourdhui <= echeance) etat = "a_payer";
      else if (!debutBanque || debutBanque > finControle) etat = "sans_banque";
      else etat = "non_vu";
      return { mois: m, facture, nbFactures: fs.length, paye, sansFacture, etat };
    });
    bilans.push({
      cle,
      nom: g.nom,
      supplier: g.supplier,
      mode,
      modeConstate,
      mois: lignes,
      paiements,
      totalFacture: lignes.reduce((s, l) => s + l.facture, 0),
      totalPaye: lignes.reduce((s, l) => s + l.paye, 0),
      totalSansFacture: lignes.reduce((s, l) => s + l.sansFacture, 0),
    });
  }

  // 3. Remises de virements groupés : composées de totaux mensuels (non encore payés) de fournisseurs en virement.
  const remises: RemiseExpliquee[] = [];
  const dejaDansRemise = new Set<string>(); // cle|mois
  for (const d of debits.filter((x) => x.type === "remise").sort((a, b) => a.date.localeCompare(b.date))) {
    const cands: { cle: string; nom: string; mois: string; montant: number; ids: string[] }[] = [];
    for (const b of bilans) {
      if (b.mode !== "virement") continue;
      for (const m of [ajoutMois(d.date.slice(0, 7), -1), ajoutMois(d.date.slice(0, 7), -2), d.date.slice(0, 7)]) {
        if (dejaDansRemise.has(`${b.cle}|${m}`)) continue;
        const g = groupes.get(b.cle)!;
        const ids = g.factures.filter((f) => f.mois === m && !payees.has(f.id) && f.dateFacture <= d.date).map((f) => f.id);
        const montant = g.factures.filter((f) => ids.includes(f.id)).reduce((s, f) => s + f.montantTTC, 0);
        if (montant > 0) cands.push({ cle: b.cle, nom: b.nom, mois: m, montant, ids });
      }
    }
    const combi = sommeExacte(cands.map((c) => c.montant), d.montant);
    // Un même fournisseur ne peut pas apparaître deux fois pour le même mois (déjà garanti), ni deux mois si c'est ambigu : on accepte.
    if (!combi) {
      remises.push({ debit: d, groupes: null });
      continue;
    }
    const choisis = combi.map((i) => cands[i]);
    for (const c of choisis) {
      dejaDansRemise.add(`${c.cle}|${c.mois}`);
      for (const id of c.ids) payees.set(id, { date: d.date, mode: "virement" });
      const b = bilans.find((x) => x.cle === c.cle)!;
      b.paiements.push({ debitId: d.id, date: d.date, montant: c.montant, type: "remise", factures: c.ids });
      const l = b.mois.find((x) => x.mois === c.mois);
      if (l) {
        l.paye += c.montant;
        if (l.etat !== "manquantes") l.etat = l.paye >= l.facture - TOL ? "paye" : "partiel";
      }
      b.totalPaye += c.montant;
    }
    remises.push({ debit: d, groupes: choisis.map(({ cle, nom, mois, montant }) => ({ cle, nom, mois, montant })) });
  }

  // 4. Débits à des tiers sans fiche fournisseur : regroupés par bénéficiaire.
  const hors = new Set((opt.horsFournisseurs ?? []).map(normTexte));
  const tiers = new Map<string, TiersSansFournisseur>();
  for (const d of debits) {
    // Les débits de carte (« TOT DIF » = carte à débit différé) ne disent pas où la carte a servi.
    if (pris.has(d.id) || !d.tiers || !["prelevement", "virement"].includes(d.type)) continue;
    if (JAMAIS_FOURNISSEUR.test(d.tiers) || JAMAIS_FOURNISSEUR.test(normTexte(d.libelle)) || hors.has(d.tiers)) continue;
    const t = tiers.get(d.tiers) ?? { tiers: d.tiers, type: d.type, nombre: 0, total: 0, premier: d.date, dernier: d.date, debits: [] };
    t.nombre++;
    t.total += d.montant;
    t.premier = d.date < t.premier ? d.date : t.premier;
    t.dernier = d.date > t.dernier ? d.date : t.dernier;
    t.debits.push(d);
    tiers.set(d.tiers, t);
  }

  const aPointer = [...payees.entries()]
    .filter(([id]) => factures.find((f) => f.id === id)?.statut === "a_payer")
    .map(([factureId, p]) => ({ factureId, ...p }));

  const poids = (b: BilanFournisseur) => b.totalSansFacture + b.mois.filter((l) => l.etat === "non_vu").reduce((s, l) => s + l.facture - l.paye, 0);
  return {
    depuis: opt.depuis,
    jusqua,
    ...(debutBanque ? { debutBanque } : {}),
    fournisseurs: bilans.sort((a, b) => poids(b) - poids(a) || b.totalFacture - a.totalFacture),
    remises,
    sansFournisseur: [...tiers.values()].sort((a, b) => b.total - a.total),
    aPointer,
  };
}
