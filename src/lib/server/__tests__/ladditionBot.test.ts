import { existsSync } from "node:fs";
import http from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { fauxExport } from "@/lib/__tests__/fauxExport";

/**
 * Robot L'Addition contre une fausse copie locale du site : connexion, détail des services + export Excel,
 * et repli sur la page Comptabilité CA/TVA quand l'export n'existe pas.
 * Lancé seulement si un Chrome local est disponible (CHROME_PATH ou celui de Playwright).
 */
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const avecChrome = existsSync(CHROME);
const OCTOBRE = { caTtcNet: 20032425, ttc10: 19468025, ttc20: 137200, ttc55: 427200 };
const SERVICES: [string, number, number, number, number][] = [
  ["2026-10-01", 11540.35, 11100.35, 104, 336],
  ["2026-10-02", 1265.25, 1223.25, 0, 42],
  ["2026-10-31", 187518.65, 182356.65, 1268, 3894],
  ["2026-11-01", 10395.4, 10305.4, 90, 0],
];

let avecExport = true;
let server: http.Server;
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const menu = `<nav><div onclick="document.getElementById('sub').style.display='block'">Comptabilité</div><div id="sub" style="display:none"><a href="/v2/accounting?start=2026-11-01&end=2026-11-05">Comptabilité CA/TVA, paiements</a></div></nav>`;

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const connecte = (req.headers.cookie ?? "").includes("sess=1");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/" || u.pathname === "/login") {
      if (connecte) { res.statusCode = 302; res.setHeader("location", "/v2/shift-details"); res.end(); return; }
      res.end(page(`<form method="post" action="/auth"><input type="email" name="email"><input type="password" name="pwd"><button>Se connecter</button></form>`));
    } else if (u.pathname === "/auth") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const p = new URLSearchParams(b);
        if (p.get("pwd") !== "secret") { res.end(page(`<p>Erreur</p><form><input type="email"><input type="password"></form>`)); return; }
        res.statusCode = 302; res.setHeader("set-cookie", "sess=1; Path=/"); res.setHeader("location", "/v2/shift-details"); res.end();
      });
    } else if (u.pathname === "/v2/shift-details") {
      if (!avecExport) { res.end(page(menu)); return; }
      const s = u.searchParams.get("start"), e = u.searchParams.get("end");
      if (!s || !e) { res.statusCode = 302; res.setHeader("location", "/v2/shift-details?start=2026-10-06&end=2026-11-05"); res.end(); return; }
      res.end(page(`${menu}<h1>Détail des services</h1><button onclick="document.getElementById('fmt').style.display='block'">Exporter</button><div id="fmt" style="display:none"><a href="/export?start=${s}&end=${e}">Excel</a></div>`));
    } else if (u.pathname === "/export") {
      const s = u.searchParams.get("start")!, e = u.searchParams.get("end")!;
      const buf = Buffer.from(await fauxExport(SERVICES.filter(([j]) => j >= s && j <= e)));
      res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`detail-services-Tib’s 19-${s}-${e}.xlsx`)}`);
      res.end(buf);
    } else if (u.pathname === "/v2/accounting") {
      const s = u.searchParams.get("start")!, e = u.searchParams.get("end")!;
      const fr = (d: string) => d.split("-").reverse().join("/");
      const oct = s === "2026-10-01";
      res.end(page(`<h1>Du ${fr(s)} au ${fr(e)}</h1><table><tr><th>CA TTC net</th><th>TTC 5,5 %</th><th>TTC 10 %</th><th>TTC 20 %</th></tr><tr><td>${oct ? "200 324,25 €" : "1,00 €"}</td><td>4 272,00 €</td><td>194 680,25 €</td><td>1 372,00 €</td></tr></table>`));
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise<void>((r) => server.listen(0, r));
  process.env.LADDITION_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  process.env.CHROME_PATH = CHROME;
});
afterAll(() => server.close());

it.skipIf(!avecChrome)("robot : export Excel du détail des services, pour le mois demandé", async () => {
  avecExport = true;
  const { extraireMois } = await import("../ladditionBot");
  const r = await extraireMois({ identifiant: "a@b.fr", motDePasse: "secret", mois: "2026-10" });
  expect(r.noteExport).toBeUndefined();
  expect(r.methode).toBe("export");
  expect(r.periodeConfirmee).toBe(true);
  expect(r.chiffres).toEqual(OCTOBRE);
}, 90_000);

it.skipIf(!avecChrome)("robot : repli sur Comptabilité CA/TVA, et mauvais mot de passe", async () => {
  avecExport = false;
  const { extraireMois } = await import("../ladditionBot");
  const r = await extraireMois({ identifiant: "a@b.fr", motDePasse: "secret", mois: "2026-10" });
  expect(r.methode).toBe("page");
  expect(r.noteExport).toMatch(/export introuvable/);
  expect(r.periodeConfirmee).toBe(true);
  expect(r.chiffres).toEqual(OCTOBRE);
  await expect(extraireMois({ identifiant: "a@b.fr", motDePasse: "faux", mois: "2026-10" })).rejects.toThrow(/refusé/);
}, 90_000);
