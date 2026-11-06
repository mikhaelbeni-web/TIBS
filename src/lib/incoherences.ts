import { isCashDeposit, isUber } from "./cashImport";
import { daysBetween, formatEuros } from "./money";
import type { BankLine, CashLine } from "./reconcile";
import {
  comparerUber,
  comparerUberBanque,
  comparerUberJour,
  controleTotal,
  estVirementTitres,
  pointageMoisCB,
  type ComparaisonCB,
  type TicketZ,
  type VersementUber,
} from "./ticketZ";

/**
 * Incohérences à faire remonter sur l'accueil (demande du gérant, 06/11/2026) : tout ce que les contrôles de la caisse,
 * de la banque et d'Uber Eats ne savent pas expliquer. Un écart expliqué (tickets-resto passés en CB, lot d'un TPE
 * crédité le lendemain qui compense le jour voisin) n'en est pas un. Une donnée qui peut encore arriver (remises
 * créditées en plusieurs fois, ticket Z du jour pas encore relevé) reste « en attente » au lieu de sonner l'alerte.
 */

export type TypeIncoherence = "cb" | "cb_sans_remise" | "remise_sans_caisse" | "total_z" | "uber_jour" | "uber_semaine" | "uber_banque" | "titres";

export interface Incoherence {
  cle: string;
  type: TypeIncoherence;
  /** Date de tri : journée de service, ou jour du crédit / du versement. */
  date: string;
  /** Journée à ouvrir dans « Jour à jour ». */
  jour?: string;
  titre: string;
  detail: string;
  /** Écart en centimes (signe : + = plus en banque / chez Uber que dans la caisse). */
  ecart?: number;
}

export interface BilanIncoherences {
  le: number;
  depuis: string;
  jusqua: string;
  liste: Incoherence[];
  /** Ce qui peut encore se régler tout seul (crédit du jour incomplet, Z pas encore relevé). */
  attente: { cle: string; titre: string }[];
}

export interface EntreeCaisse {
  id: string;
  date: string;
  cb: number;
  uber?: number;
  uberCommandes?: number;
  total?: number;
  paiements?: { libelle: string; montant: number; categorie: string; nombre?: number }[];
  ticketZ?: { dateTicket: string; heureCloture?: string };
}

export interface DonneesIncoherences {
  cash: EntreeCaisse[];
  bank: BankLine[];
  versementsUber: VersementUber[];
  uberJours: { date: string; commandes: number; ventes: number; partiel?: boolean }[];
  /** AAAA-MM-JJ, heure de Paris. */
  today: string;
  /** Premier jour contrôlé (par défaut : le 1er du mois précédent). */
  depuis?: string;
  maxDays?: number;
  maxFeeRate?: number;
}

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const fr = (iso: string) => iso.split("-").reverse().join("/");
const signe = (c: number) => (c > 0 ? "+" : c < 0 ? "−" : "") + formatEuros(Math.abs(c));
/** Délai laissé aux émetteurs de tickets-resto pour payer (virements groupés, en retard). */
const DELAI_TITRES = 35;

export function debutParDefaut(today: string): string {
  const [a, m] = today.split("-").map(Number);
  return m === 1 ? `${a - 1}-12-01` : `${a}-${String(m - 1).padStart(2, "0")}-01`;
}

function moisEntre(debut: string, fin: string): string[] {
  const out: string[] = [];
  for (let m = debut.slice(0, 7); m <= fin.slice(0, 7); ) {
    out.push(m);
    const [a, mm] = m.split("-").map(Number);
    m = mm === 12 ? `${a + 1}-01` : `${a}-${String(mm + 1).padStart(2, "0")}`;
  }
  return out;
}

const joursTexte = (g: ComparaisonCB) => {
  const j = (g.joursCouverts ?? []).map((c) => fr(c.date));
  return j.length > 1 ? `des journées du ${j.join(", ")}` : `de la journée du ${j[0] ?? "?"}`;
};

export function listerIncoherences(d: DonneesIncoherences): BilanIncoherences {
  const { today } = d;
  const depuis = d.depuis ?? debutParDefaut(today);
  const options = { maxDays: d.maxDays ?? 5, maxFeeRate: d.maxFeeRate ?? 0.03, today, lignes: d.bank };
  const liste: Incoherence[] = [];
  const attente: BilanIncoherences["attente"] = [];
  const dansFenetre = (iso: string) => iso >= depuis && iso <= today;

  // --- CB : caisse ↔ remises CB, seulement sur la période couverte par le relevé bancaire.
  const debutBanque = d.bank.reduce((m, b) => (b.date < m ? b.date : m), "9999-12-31");
  const finBanque = d.bank.reduce((m, b) => (b.date > m ? b.date : m), "");
  if (d.bank.length) {
    // Journées de service couvertes par le relevé (le 1er jour du relevé peut être incomplet).
    const cbCaisse: CashLine[] = d.cash.filter((c) => c.date >= debutBanque).map((c) => ({ id: c.id, date: c.date, amount: c.cb }));
    const credits = d.bank.filter((b) => b.amount > 0 && !isCashDeposit(b.libelle) && !isUber(b.libelle));
    const premierJourCaisse = cbCaisse.reduce((m, c) => (c.amount > 0 && c.date < m ? c.date : m), "9999-12-31");
    const vus = new Set<string>();
    // Tickets-resto passés en CB, par jour de crédit (petit manque de chaque crédit).
    const titres = new Map<string, number>();
    for (const mois of moisEntre(depuis, today)) {
      const p = pointageMoisCB(mois, cbCaisse, credits, options);
      for (const g of p.groupes) {
        if (!g.banque || vus.has(g.banque.date)) continue;
        vus.add(g.banque.date);
        if (g.titres) titres.set(g.banque.date, g.titres);
        if (!dansFenetre(g.banque.date) || g.statut !== "ecart" || g.ecart === undefined) continue;
        const premier = g.joursCouverts?.[0]?.date ?? g.banque.date;
        const cle = `cb:${g.banque.date}`;
        // Crédit le plus récent du relevé, encore en manque : les remises arrivent parfois en plusieurs fois.
        if (g.ecart < 0 && g.banque.date >= finBanque && daysBetween(g.banque.date, today) <= 3) {
          attente.push({ cle, titre: `CB ${joursTexte(g)} : crédit du ${fr(g.banque.date)} pas encore complet` });
          continue;
        }
        liste.push({
          cle,
          type: "cb",
          date: premier,
          jour: premier,
          titre: g.ecart < 0 ? `CB : il manque ${formatEuros(-g.ecart)} en banque` : `CB : ${formatEuros(g.ecart)} de trop en banque`,
          detail: `CB ${joursTexte(g)} : ${formatEuros(g.caisse)} en caisse, ${formatEuros(g.banque.montant)} de remises créditées le ${fr(g.banque.date)}.`,
          ecart: g.ecart,
        });
      }
      for (const s of p.sansRemise) {
        if (!dansFenetre(s.jour.date)) continue;
        const cle = `cb-sans-remise:${s.jour.date}`;
        if (s.statut !== "ecart") {
          attente.push({ cle, titre: `CB du ${fr(s.jour.date)} : remise pas encore sur le compte` });
          continue;
        }
        liste.push({
          cle,
          type: "cb_sans_remise",
          date: s.jour.date,
          jour: s.jour.date,
          titre: "CB sans remise en banque",
          detail: `${formatEuros(s.jour.amount)} de CB en caisse le ${fr(s.jour.date)}, aucune remise CB trouvée sur le compte.`,
          ecart: -s.jour.amount,
        });
      }
      for (const r of p.remisesSeules) {
        // Avant la première journée de caisse connue : rien à comparer.
        if (!dansFenetre(r.date) || r.date <= premierJourCaisse) continue;
        const cle = `remise:${r.id}`;
        // Le ticket Z de la veille est relevé chaque matin : on lui laisse le temps d'arriver.
        if (daysBetween(r.date, today) <= 2) {
          attente.push({ cle, titre: `Remise CB du ${fr(r.date)} : journée de caisse pas encore relevée` });
          continue;
        }
        liste.push({
          cle,
          type: "remise_sans_caisse",
          date: r.date,
          jour: addDays(r.date, -1),
          titre: "Remise CB sans journée de caisse",
          detail: `Remise CB de ${formatEuros(r.amount)} créditée le ${fr(r.date)} : aucune journée de caisse ne la couvre (ticket Z manquant ?).`,
          ecart: r.amount,
        });
      }
    }

    // --- Tickets-resto passés en CB : ceux de plus de 5 semaines doivent avoir été payés par les émetteurs.
    const anciens = [...titres].filter(([c]) => dansFenetre(c) && daysBetween(c, today) > DELAI_TITRES).reduce((t, [, m]) => t + m, 0);
    const recus = d.bank.filter((b) => b.amount > 0 && estVirementTitres(b.libelle) && dansFenetre(b.date)).reduce((t, b) => t + b.amount, 0);
    if (anciens - recus > 10000) {
      liste.push({
        cle: `titres:${today.slice(0, 7)}`,
        type: "titres",
        date: today,
        titre: "Tickets-resto non payés par les émetteurs",
        detail: `Depuis le ${fr(depuis)} : ${formatEuros(anciens)} de tickets-resto passés en CB il y a plus de ${DELAI_TITRES} jours, ${formatEuros(recus)} reçus des émetteurs.`,
        ecart: recus - anciens,
      });
    }
  }

  // --- Ticket Z : le total imprimé = la somme des moyens de paiement.
  for (const c of d.cash) {
    if (!dansFenetre(c.date) || !c.paiements?.length || c.total === undefined) continue;
    const t: TicketZ = {
      dateTicket: c.ticketZ?.dateTicket ?? c.date,
      heureCloture: c.ticketZ?.heureCloture,
      paiements: c.paiements.map((p) => ({ ...p, categorie: p.categorie as TicketZ["paiements"][number]["categorie"] })),
      total: c.total,
    };
    const r = controleTotal(t);
    if (r.statut === "ecart" && r.ecart !== undefined) {
      liste.push({
        cle: `total:${c.date}`,
        type: "total_z",
        date: c.date,
        jour: c.date,
        titre: "Ticket Z : total ≠ somme des paiements",
        detail: `Journée du ${fr(c.date)} : paiements ${formatEuros(r.somme)}, total imprimé ${formatEuros(r.total ?? 0)} (${signe(r.ecart)}).`,
        ecart: r.ecart,
      });
    }
  }

  // --- Uber du jour : même nombre de commandes et même montant que le Manager Uber Eats.
  const uberParJour = new Map(d.uberJours.map((u) => [u.date, u]));
  for (const c of d.cash) {
    const u = uberParJour.get(c.date);
    if (!dansFenetre(c.date) || !u || u.partiel) continue;
    const r = comparerUberJour({ montant: c.uber ?? 0, commandes: c.uberCommandes }, u);
    if (r.statut !== "ecart") continue;
    const morceaux = [
      r.ecartCommandes ? `${u.commandes} commande(s) chez Uber, ${c.uberCommandes} en caisse` : "",
      r.ecartMontant && Math.abs(r.ecartMontant) > 100 ? `${formatEuros(u.ventes)} chez Uber, ${formatEuros(c.uber ?? 0)} en caisse` : "",
    ].filter(Boolean);
    liste.push({
      cle: `uber-jour:${c.date}`,
      type: "uber_jour",
      date: c.date,
      jour: c.date,
      titre: "Uber Eats du jour ≠ caisse",
      detail: `Journée du ${fr(c.date)} : ${morceaux.join(" ; ")}.`,
      ecart: r.ecartMontant,
    });
  }

  // --- Uber de la semaine : ventes du récap Uber ↔ Uber des Z, puis net annoncé ↔ virement sur le compte.
  const ubersCaisse: CashLine[] = d.cash.filter((c) => c.uber !== undefined).map((c) => ({ id: c.id, date: c.date, amount: c.uber ?? 0 }));
  const virementsUber = d.bank.filter((b) => b.amount > 0 && isUber(b.libelle));
  const semaines = new Set<string>();
  for (const c of [...ubersCaisse].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!dansFenetre(c.date) || !c.amount) continue;
    const r = comparerUber(c.date, ubersCaisse, d.versementsUber, { today });
    const cle = `${r.semaine.debut}:${r.semaine.fin}`;
    if (semaines.has(cle)) continue;
    semaines.add(cle);
    // Semaine pas finie : rien à comparer encore.
    if (r.semaine.fin >= today) continue;
    const periode = `semaine du ${fr(r.semaine.debut)} au ${fr(r.semaine.fin)}`;
    if (r.statut === "ecart") {
      liste.push({
        cle: `uber-semaine:${cle}`,
        type: "uber_semaine",
        date: r.semaine.debut,
        jour: r.semaine.debut,
        titre: r.versement ? "Uber Eats de la semaine ≠ caisse" : "Versement Uber Eats introuvable",
        detail: r.versement
          ? r.joursSaisis < 7
            ? `Uber, ${periode} : ${r.joursSaisis} journée(s) de caisse sur 7, impossible de comparer aux ${formatEuros(r.versement.brut ?? 0)} de ventes Uber.`
            : `Uber, ${periode} : ${formatEuros(r.versement.brut ?? 0)} de ventes chez Uber, ${formatEuros(r.caisseSemaine)} dans les Z (${signe(r.ecart ?? 0)}).`
          : `Uber, ${periode} : ${formatEuros(r.caisseSemaine)} dans les Z, aucun récap ni versement Uber Eats trouvé.`,
        ...(r.ecart !== undefined ? { ecart: r.ecart } : {}),
      });
    } else if (r.statut === "attente" && !r.versement) {
      attente.push({ cle: `uber-semaine:${cle}`, titre: `Uber, ${periode} : versement pas encore reçu` });
    }
    // Le virement Uber sur le compte, seulement si le relevé couvre la date du versement.
    if (r.versement && d.bank.length && r.versement.date > debutBanque && dansFenetre(r.versement.date)) {
      const b = comparerUberBanque(r.versement, virementsUber, { today });
      if (b.statut === "ecart") {
        liste.push({
          cle: `uber-banque:${r.versement.id}`,
          type: "uber_banque",
          date: r.versement.date,
          jour: r.semaine.debut,
          titre: "Virement Uber Eats absent du compte",
          detail: `Uber annonce ${formatEuros(r.versement.montant)} versés le ${fr(r.versement.date)} (${periode}) : aucun virement Uber de ce montant sur le compte.`,
          ecart: -r.versement.montant,
        });
      } else if (b.statut === "attente") {
        attente.push({ cle: `uber-banque:${r.versement.id}`, titre: `Virement Uber du ${fr(r.versement.date)} pas encore sur le compte` });
      }
    }
  }

  liste.sort((a, b) => b.date.localeCompare(a.date) || a.cle.localeCompare(b.cle));
  return { le: Date.now(), depuis, jusqua: today, liste, attente };
}
