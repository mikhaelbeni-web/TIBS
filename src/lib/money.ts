/** Convertit "1 234,56", "1234.56", "-12,5 €" ou un nombre en centimes. Renvoie null si illisible. */
export function toCents(input: unknown): number | null {
  if (typeof input === "number") {
    return Number.isFinite(input) ? Math.round(input * 100) : null;
  }
  if (typeof input !== "string") return null;
  let s = input.replace(/[\s  €]/g, "").trim();
  if (!s) return null;
  // "1.234,56" -> "1234.56" ; "1,234.56" -> "1234.56"
  if (s.includes(",") && s.includes(".")) {
    s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else {
    s = s.replace(",", ".");
  }
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(parseFloat(s) * 100);
}

export function formatEuros(cents: number): string {
  return (cents / 100).toLocaleString("fr-FR", { style: "currency", currency: "EUR" });
}

/** Normalise une date ("31/10/2026", "2026-10-31", Date, numéro de série Excel) en AAAA-MM-JJ. */
export function toIsoDate(input: unknown): string | null {
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate())).toISOString().slice(0, 10);
  }
  if (typeof input === "number" && input > 20000 && input < 80000) {
    // Numéro de série Excel (jours depuis le 30/12/1899)
    return new Date(Date.UTC(1899, 11, 30) + input * 86400000).toISOString().slice(0, 10);
  }
  if (typeof input !== "string") return null;
  const s = input.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}
