import ExcelJS from "exceljs";

/** Fausse copie de l'export « Détails par service » (mêmes en-têtes que le vrai fichier d'octobre 2026). */
export async function fauxExport(services: [string, number, number, number, number][]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Détails par service");
  // prettier-ignore
  ws.addRow(["Services (Tib’s 19)", "Jour", "CA TTC Net", "CA HT", "Remises", "Offerts", "CA TTC Brut (hors rabais)", "TTC 0.00%", "HT 0.00%", "TVA 0.00%", "TTC 10.00%", "HT 10.00%", "TVA 10.00%", "TTC 20.00%", "HT 20.00%", "TVA 20.00%", "TTC 5.50%", "HT 5.50%", "TVA 5.50%", "Couverts", "Commandes", "Panier moy", "Ticket moy", "Cash", "CB", "Compte client", "En compte ", "LE TIBS ", "UBER", "Commentaires", "URL"]);
  const sum = (i: number) => services.reduce((t, s) => t + (s[i] as number), 0);
  const ligne = (a: string, b: string, ca: number, t10: number, t20: number, t55: number) =>
    [a, b, ca, 0, 0, 0, ca, 0, 0, 0, t10, 0, 0, t20, 0, 0, t55, 0, 0, 0, 0, 0, 0, 100, ca - 200, 0, 0, 0, 100, null];
  ws.addRow(ligne("TOTAL", "-", sum(1), sum(2), sum(3), sum(4)));
  for (const [jour, ca, t10, t20, t55] of services) {
    const [y, m, d] = jour.split("-");
    const r = ws.addRow(ligne(`Du ${d}/${m}/${y} (11:13) au ${d}/${m}/${y} (23:42)`, `${Number(d)} ${m}`, ca, t10, t20, t55));
    r.getCell(31).value = { text: "https://data.laddition.com/z.pdf", hyperlink: "https://data.laddition.com/z.pdf" };
  }
  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
