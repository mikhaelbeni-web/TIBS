/**
 * Chiffres mensuels relevés dans L'Addition (Comptabilité > Comptabilité CA/TVA),
 * les seuls que le comptable demande chaque mois : CA TTC net et sa ventilation par taux.
 * Montants en centimes.
 */
export interface CaMensuel {
  mois: string; // AAAA-MM
  caTtcNet: number;
  ttc10: number;
  ttc20: number;
  ttc55: number;
  /** laddition : robot ; export : fichier « Détails par service » importé ; manuel : saisi. */
  source: "laddition" | "export" | "manuel";
  coherent?: boolean;
  majLe: number;
}

export type ChiffresCa = Pick<CaMensuel, "caTtcNet" | "ttc10" | "ttc20" | "ttc55">;

export const CHAMPS_CA: { key: keyof ChiffresCa; label: string }[] = [
  { key: "caTtcNet", label: "CA TTC net" },
  { key: "ttc10", label: "TTC 10 %" },
  { key: "ttc20", label: "TTC 20 %" },
  { key: "ttc55", label: "TTC 5,5 %" },
];

/** Libellés tels qu'affichés par L'Addition (tolère espaces, « 10,00 % », casse). */
const LIBELLES: Record<keyof ChiffresCa, RegExp> = {
  caTtcNet: /CA\s*TTC\s*net/i,
  ttc10: /TTC\s*10(?:[,.]0+)?\s*%/i,
  ttc20: /TTC\s*20(?:[,.]0+)?\s*%/i,
  ttc55: /TTC\s*5[,.]50?\s*%/i,
};

const MONTANT = /-?\d{1,3}(?:[   .]\d{3})+(?:,\d{1,2})?|-?\d+(?:,\d{1,2})?/;

/** « 200 324,25 € » → 20032425 centimes. null si aucun montant. */
export function parseMontantFr(s: string): number | null {
  const m = s.match(MONTANT);
  if (!m) return null;
  const [ent, dec = ""] = m[0].replace(/[   .]/g, "").split(",");
  const neg = ent.startsWith("-");
  const cents = Math.abs(Number(ent)) * 100 + Number(dec.padEnd(2, "0") || 0);
  return Number.isFinite(cents) ? (neg ? -cents : cents) : null;
}

const estMontant = (cell: string) => /^\s*-?[\d   .]+(?:,\d{1,2})?\s*(?:€|EUR)?\s*$/i.test(cell) && /\d/.test(cell);

/**
 * Trouve un montant associé à un libellé dans le texte de la page :
 * - sur la même ligne, juste après le libellé (« CA TTC net 200 324,25 € ») ;
 * - ou dans un tableau (cellules séparées par des tabulations) : même colonne, lignes suivantes.
 */
function montantPour(lignes: string[][], libelle: RegExp): number | null {
  for (let i = 0; i < lignes.length; i++) {
    const cells = lignes[i];
    for (let c = 0; c < cells.length; c++) {
      const m = cells[c].match(libelle);
      if (!m) continue;
      // Reste de la même cellule, après le libellé.
      const reste = cells[c].slice((m.index ?? 0) + m[0].length);
      if (/\d/.test(reste)) {
        const v = parseMontantFr(reste);
        if (v !== null) return v;
      }
      // Cellule suivante de la même ligne.
      if (cells[c + 1] !== undefined && estMontant(cells[c + 1])) return parseMontantFr(cells[c + 1]);
      // Même colonne, lignes suivantes (en-tête de tableau), ou ligne suivante seule (libellé au-dessus du chiffre).
      for (let j = i + 1; j < Math.min(lignes.length, i + 4); j++) {
        const cell = lignes[j].length > 1 ? lignes[j][c] : lignes[j][0];
        if (cell !== undefined && estMontant(cell)) return parseMontantFr(cell);
      }
    }
  }
  return null;
}

/**
 * Tableau « CA/TVA par famille » de L'Addition (reporting-pos, /vat-family) : colonnes CA TTC, CA HT*, TVA,
 * Remises, Offerts, CA TTC Brut ; une ligne Total, puis par famille des sous-lignes par taux (« 10% », « 5.5% »…).
 * Montants à point décimal, sans espace ni €. CA TTC = premier montant après le libellé.
 * Renvoie null si le texte ne ressemble pas à ce tableau.
 */
export function extraireTableauTva(texte: string): Record<keyof ChiffresCa, number | null> | null {
  const debut = texte.search(/CA\s*TTC/i);
  if (debut < 0) return null;
  const tokens = texte.slice(debut).split(/\s+/).filter(Boolean);
  const nombre = /^-?\d+(?:[.,]\d+)?$/;
  let attente: "total" | number | null = null;
  let total: number | null = null;
  const parTaux = new Map<number, number>();
  for (const t of tokens) {
    if (/^total$/i.test(t)) {
      attente = total === null ? "total" : null;
      continue;
    }
    const taux = t.match(/^(\d+(?:[.,]\d+)?)%$/);
    if (taux) {
      attente = Number(taux[1].replace(",", "."));
      continue;
    }
    if (attente === null || !nombre.test(t)) continue;
    const cents = Math.round(Number(t.replace(",", ".")) * 100);
    if (attente === "total") total = cents;
    else parTaux.set(attente, (parTaux.get(attente) ?? 0) + cents);
    attente = null;
  }
  if (total === null || parTaux.size === 0) return null;
  return { caTtcNet: total, ttc10: parTaux.get(10) ?? 0, ttc20: parTaux.get(20) ?? 0, ttc55: parTaux.get(5.5) ?? 0 };
}

/** Extrait les quatre chiffres du texte de la page L'Addition. Les absents valent null. */
export function extraireChiffres(texte: string): Record<keyof ChiffresCa, number | null> {
  const tableau = extraireTableauTva(texte);
  if (tableau) return tableau;
  const lignes = texte
    .split(/\r?\n/)
    .map((l) => l.split("\t").map((c) => c.trim()))
    .filter((cells) => cells.some(Boolean));
  return {
    caTtcNet: montantPour(lignes, LIBELLES.caTtcNet),
    ttc10: montantPour(lignes, LIBELLES.ttc10),
    ttc20: montantPour(lignes, LIBELLES.ttc20),
    ttc55: montantPour(lignes, LIBELLES.ttc55),
  };
}

/** Les trois taux doivent faire le CA TTC net (à 2 centimes près pour les arrondis). */
export function chiffresCoherents(c: ChiffresCa): boolean {
  return Math.abs(c.ttc10 + c.ttc20 + c.ttc55 - c.caTtcNet) <= 2;
}

/** Premier et dernier jour d'un mois AAAA-MM. */
export function bornesMois(mois: string): { debut: string; fin: string } {
  const [y, m] = mois.split("-").map(Number);
  return { debut: `${mois}-01`, fin: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}

export const estMois = (s: unknown): s is string => typeof s === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

/** « 200 324,25 » (format attendu par le comptable, sans symbole). */
export const montantFr = (cents: number) =>
  (cents / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
