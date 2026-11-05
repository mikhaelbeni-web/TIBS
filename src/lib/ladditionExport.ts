import { bornesMois, type ChiffresCa } from "./laddition";

/**
 * Export Excel « Détails par service » de L'Addition (reporting > détail des services, bouton d'export) :
 * une ligne TOTAL puis une ligne par service (« Du 01/10/2026 (11:13) au 02/10/2026 (00:42) »),
 * avec CA TTC Net, TTC 10.00 %, TTC 20.00 %, TTC 5.50 %, Cash, CB, UBER et le lien du ticket Z.
 * Nom du fichier : detail-services-<établissement>-AAAA-MM-JJ-AAAA-MM-JJ.xlsx (période exportée).
 */
export interface ServiceExport {
  jour: string; // AAAA-MM-JJ d'ouverture du service
  caTtcNet: number; // centimes
  ttc10: number;
  ttc20: number;
  ttc55: number;
  cash: number;
  cb: number;
  uber: number;
  /** Lien signé vers le PDF du ticket Z du service (colonne URL), s'il est présent. */
  zUrl?: string;
}

export interface ExportServices {
  etablissement: string;
  total: ChiffresCa | null;
  services: ServiceExport[];
}

const norm = (h: unknown) =>
  String(h ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** Euros (nombre ou texte « 1 234,50 ») → centimes. */
function cents(v: unknown): number {
  if (typeof v === "number") return Math.round(v * 100);
  if (typeof v === "string") {
    const n = Number(v.replace(/[\s  €]/g, "").replace(",", "."));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  return 0;
}

const COLONNES = {
  caTtcNet: ["cattcnet"],
  ttc10: ["ttc1000", "ttc10"],
  ttc20: ["ttc2000", "ttc20"],
  ttc55: ["ttc550", "ttc55"],
  cash: ["cash", "especes"],
  cb: ["cb"],
  uber: ["uber", "ubereats"],
  url: ["url", "lien", "ticketz", "lienticketz", "urlticketz"],
} as const;

/** Lit les lignes brutes de la feuille (tableaux de cellules, en-têtes compris). */
export function lireExportServices(rows: unknown[][]): ExportServices {
  const h = rows.findIndex((r) => r.some((c) => norm(c) === "cattcnet"));
  if (h < 0) throw new Error("Ce fichier n'est pas l'export « Détails par service » de L'Addition (colonne « CA TTC Net » introuvable).");
  const headers = rows[h].map(norm);
  const col = Object.fromEntries(
    Object.entries(COLONNES).map(([k, noms]) => [k, headers.findIndex((x) => (noms as readonly string[]).includes(x))]),
  ) as Record<keyof typeof COLONNES, number>;
  for (const k of ["caTtcNet", "ttc10", "ttc20", "ttc55"] as const) {
    if (col[k] < 0) throw new Error(`Colonne « ${k} » introuvable dans l'export L'Addition.`);
  }
  const val = (r: unknown[], k: keyof typeof COLONNES) => (col[k] >= 0 ? cents(r[col[k]]) : 0);
  const chiffres = (r: unknown[]): ChiffresCa => ({ caTtcNet: val(r, "caTtcNet"), ttc10: val(r, "ttc10"), ttc20: val(r, "ttc20"), ttc55: val(r, "ttc55") });

  let total: ChiffresCa | null = null;
  const services: ServiceExport[] = [];
  for (const r of rows.slice(h + 1)) {
    const premiere = String(r[0] ?? "").trim();
    if (/^total$/i.test(premiere)) {
      total = chiffres(r);
      continue;
    }
    const m = premiere.match(/^Du\s+(\d{2})\/(\d{2})\/(\d{4})/i);
    if (!m) continue;
    // Lien signé du Z : sa colonne, sinon n'importe quelle cellule qui pointe vers L'Addition (http ou https).
    const lien = (c: unknown) => (/^https?:\/\/\S+$/i.test(String(c ?? "").trim()) ? String(c).trim() : "");
    const url = (col.url >= 0 ? lien(r[col.url]) : "") || r.map(lien).find((u) => /laddition\.com/i.test(u)) || "";
    services.push({
      jour: `${m[3]}-${m[2]}-${m[1]}`,
      ...chiffres(r),
      cash: val(r, "cash"),
      cb: val(r, "cb"),
      uber: val(r, "uber"),
      ...(url ? { zUrl: url } : {}),
    });
  }
  const etablissement = String(rows[h][0] ?? "").match(/\(([^)]+)\)/)?.[1] ?? "";
  return { etablissement, total, services };
}

/** Période exportée, lue dans le nom du fichier (…-2026-10-01-2026-10-31.xlsx). */
export function periodeDuNom(nom: string): { debut: string; fin: string } | null {
  const m = nom.match(/(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})(?:\s*\(\d+\))?\.xlsx$/i);
  return m ? { debut: m[1], fin: m[2] } : null;
}

export interface ChiffresDuMois {
  chiffres: ChiffresCa;
  nbServices: number;
  /** La période exportée couvre tout le mois (sinon le total est partiel). null : période inconnue. */
  complet: boolean | null;
}

/** Additionne les services ouverts dans le mois (un service qui finit après minuit compte pour son jour d'ouverture). */
export function chiffresDuMois(exp: ExportServices, mois: string, periode: { debut: string; fin: string } | null): ChiffresDuMois {
  const du = exp.services.filter((s) => s.jour.startsWith(mois));
  const chiffres = du.reduce<ChiffresCa>(
    (t, s) => ({ caTtcNet: t.caTtcNet + s.caTtcNet, ttc10: t.ttc10 + s.ttc10, ttc20: t.ttc20 + s.ttc20, ttc55: t.ttc55 + s.ttc55 }),
    { caTtcNet: 0, ttc10: 0, ttc20: 0, ttc55: 0 },
  );
  const { debut, fin } = bornesMois(mois);
  return { chiffres, nbServices: du.length, complet: periode ? periode.debut <= debut && periode.fin >= fin : null };
}

/** Message d'erreur si l'export ne permet pas de donner les chiffres du mois, sinon null. */
export function problemeExport(r: ChiffresDuMois, mois: string, periode: { debut: string; fin: string } | null): string | null {
  const fr = (iso: string) => iso.split("-").reverse().join("/");
  const { debut, fin } = bornesMois(mois);
  if (r.nbServices === 0) return `Aucun service du mois ${mois} dans ce fichier${periode ? ` (il couvre du ${fr(periode.debut)} au ${fr(periode.fin)})` : ""}.`;
  if (r.complet === false && periode) {
    return `Ce fichier couvre du ${fr(periode.debut)} au ${fr(periode.fin)} : exporte du ${fr(debut)} au ${fr(fin)} pour avoir le mois complet.`;
  }
  return null;
}

/** Lignes brutes de la première feuille d'un .xlsx (navigateur ou serveur). */
export async function lignesXlsx(data: ArrayBuffer): Promise<unknown[][]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = [];
    row.eachCell({ includeEmpty: true }, (cell, c) => {
      const v = cell.value;
      cells[c - 1] = v !== null && typeof v === "object" && !(v instanceof Date) ? ("result" in v ? v.result : cell.text) : v;
    });
    rows.push(cells);
  });
  return rows;
}
