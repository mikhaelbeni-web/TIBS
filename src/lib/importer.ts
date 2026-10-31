import { toCents, toIsoDate } from "./money";
import type { Employee, TypeContrat } from "./types";

export type Row = Record<string, unknown>;

/** "Date d'embauche" -> "datedembauche" : comparaison d'en-têtes insensible aux accents/espaces. */
export function normalizeHeader(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/** Lit un fichier .xlsx ou .csv et renvoie les lignes (clés = en-têtes normalisés). */
export async function readSpreadsheet(file: File): Promise<Row[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    const Papa = (await import("papaparse")).default;
    const text = await decodeText(await file.arrayBuffer());
    const res = Papa.parse<Row>(text, {
      header: true,
      skipEmptyLines: true,
      transformHeader: normalizeHeader,
    });
    return res.data;
  }
  if (name.endsWith(".xlsx")) {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await file.arrayBuffer());
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const headers: string[] = [];
    ws.getRow(1).eachCell((cell, col) => {
      headers[col] = normalizeHeader(String(cell.text ?? ""));
    });
    const rows: Row[] = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const r: Row = {};
      row.eachCell((cell, col) => {
        const key = headers[col];
        if (!key) return;
        const v = cell.value;
        r[key] = v instanceof Date ? v : typeof v === "object" && v !== null ? cell.text : v;
      });
      if (Object.keys(r).length) rows.push(r);
    });
    return rows;
  }
  throw new Error("Format non pris en charge : utilisez .xlsx ou .csv (les anciens .xls doivent être réenregistrés en .xlsx)");
}

/** Les exports bancaires français sont souvent en Windows-1252 : on tente UTF-8 puis on retombe dessus. */
function decodeText(buf: ArrayBuffer): Promise<string> {
  try {
    return Promise.resolve(new TextDecoder("utf-8", { fatal: true }).decode(buf));
  } catch {
    return Promise.resolve(new TextDecoder("windows-1252").decode(buf));
  }
}

function pick(row: Row, aliases: string[]): unknown {
  for (const a of aliases) {
    const v = row[normalizeHeader(a)];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());

function contrat(v: unknown): TypeContrat {
  const s = normalizeHeader(str(v));
  if (s.startsWith("cdd")) return "CDD";
  if (s.startsWith("appren")) return "Apprentissage";
  if (s.startsWith("extra")) return "Extra";
  if (s.startsWith("interim")) return "Interim";
  return "CDI";
}

export type EmployeeDraft = Omit<Employee, "createdAt" | "dpaeStatut">;

/** Colonnes reconnues : voir public/modele-salaries.csv. */
export function rowToEmployee(row: Row): EmployeeDraft {
  const sexe = normalizeHeader(str(pick(row, ["sexe", "genre", "civilite"])));
  return {
    nom: str(pick(row, ["nom", "nom d'usage"])).toUpperCase(),
    nomNaissance: str(pick(row, ["nom de naissance", "nom de famille"])).toUpperCase() || undefined,
    prenom: str(pick(row, ["prenom", "prénom"])),
    sexe: sexe.startsWith("f") || sexe.startsWith("mme") || sexe === "2" ? "F" : "M",
    nir: str(pick(row, ["nir", "numero de securite sociale", "securite sociale", "n ss", "nss"])).replace(/\s/g, ""),
    dateNaissance: toIsoDate(pick(row, ["date de naissance", "naissance"])) ?? "",
    lieuNaissance: str(pick(row, ["lieu de naissance", "commune de naissance", "ville de naissance"])),
    departementNaissance: str(pick(row, ["departement de naissance", "dept naissance", "departement"])),
    nationalite: str(pick(row, ["nationalite"])) || "Française",
    adresse: str(pick(row, ["adresse"])) || undefined,
    dateEmbauche: toIsoDate(pick(row, ["date d'embauche", "date embauche", "embauche", "date d'entree"])) ?? "",
    heureEmbauche: str(pick(row, ["heure d'embauche", "heure embauche", "heure"])) || "09:00",
    typeContrat: contrat(pick(row, ["type de contrat", "contrat"])),
    dateFinContrat: toIsoDate(pick(row, ["date de fin", "fin de contrat", "date fin contrat"])) ?? undefined,
    poste: str(pick(row, ["poste", "emploi", "fonction"])),
  };
}

export interface BankDraft {
  date: string;
  libelle: string;
  montant: number;
}

/** Accepte une colonne Montant signée, ou deux colonnes Débit / Crédit. Les lignes illisibles sont ignorées. */
export function rowToBank(row: Row): BankDraft | null {
  const date = toIsoDate(pick(row, ["date", "date operation", "date de l'operation", "date comptable", "date valeur"]));
  const libelle = str(pick(row, ["libelle", "libellé", "description", "intitule", "detail"]));
  let montant = toCents(pick(row, ["montant", "montant eur", "montant (eur)", "somme"]));
  if (montant === null) {
    const credit = toCents(pick(row, ["credit", "crédit", "credit eur"])) ?? 0;
    const debit = toCents(pick(row, ["debit", "débit", "debit eur"])) ?? 0;
    montant = credit - Math.abs(debit);
    if (credit === 0 && debit === 0) montant = null;
  }
  if (!date || montant === null) return null;
  return { date, libelle, montant };
}
