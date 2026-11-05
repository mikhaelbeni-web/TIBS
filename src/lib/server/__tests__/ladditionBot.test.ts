import http from "node:http";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";

/**
 * Robot L'Addition contre une fausse copie locale du site (connexion, menu, mois, tableau).
 * Lancé seulement si un Chrome local est disponible (CHROME_PATH ou celui de Playwright).
 */
const CHROME = process.env.CHROME_PATH || "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
const avecChrome = existsSync(CHROME);

let server: http.Server;
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, "http://x");
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/" || u.pathname === "/login") {
      res.end(page(`<form method="post" action="/auth"><input type="email" name="email"><input type="password" name="pwd"><button>Se connecter</button></form>`));
    } else if (u.pathname === "/auth") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const p = new URLSearchParams(b);
        if (p.get("pwd") !== "secret") { res.end(page(`<p>Erreur</p><form><input type="email"><input type="password"></form>`)); return; }
        res.statusCode = 302; res.setHeader("location", "/v2/shift-details"); res.end();
      });
    } else if (u.pathname === "/v2/shift-details") {
      res.end(page(`<nav><div onclick="document.getElementById('sub').style.display='block'">Comptabilité</div><div id="sub" style="display:none"><a href="/v2/accounting?start=2026-11-01&end=2026-11-05">Comptabilité CA/TVA, paiements</a></div></nav>`));
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

it.skipIf(!avecChrome)("robot : connexion, menu, mois, lecture", async () => {
  const { extraireMois } = await import("../ladditionBot");
  const r = await extraireMois({ identifiant: "a@b.fr", motDePasse: "secret", mois: "2026-10" });
  expect(r.periodeConfirmee).toBe(true);
  expect(r.chiffres).toEqual({ caTtcNet: 20032425, ttc10: 19468025, ttc20: 137200, ttc55: 427200 });
  await expect(extraireMois({ identifiant: "a@b.fr", motDePasse: "faux", mois: "2026-10" })).rejects.toThrow(/refusé/);
}, 90_000);
