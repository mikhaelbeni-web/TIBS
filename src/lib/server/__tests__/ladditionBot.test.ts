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
/** Connexion façon auth.laddition.com : formulaire JS qui appelle /v2/api/auth et répond 401 en JSON. */
let connexionXhr = false;
const formXhr = `<form id="f"><label>Identifiant / Email</label><input type="text" id="u"><label>Mot de passe</label><input type="password" id="p"><button type="submit">Valider</button></form>
<script>document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/v2/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: u.value, password: p.value, scope: "bo-client" }) });
  if (r.ok) location.href = "/v2/shift-details";
});</script>`;
/**
 * Pages façon reporting.laddition.com 3.x : le menu dans la page, le contenu dans une iframe d'un autre
 * domaine (localhost au lieu de 127.0.0.1), bouton d'export en icône, tableau CA/TVA dans un shadow DOM.
 */
let avecIframe = false;
let port = 0;
const iframe = (chemin: string) => `<iframe src="http://localhost:${port}${chemin}" style="width:1000px;height:600px;border:0"></iframe>`;
const frJ = (d: string) => d.split("-").reverse().join("/");
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
      if (connexionXhr) { res.end(page(formXhr)); return; }
      res.end(page(`<form method="post" action="/auth"><input type="email" name="email"><input type="password" name="pwd"><button>Se connecter</button></form>`));
    } else if (u.pathname === "/v2/api/auth") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const { login, password } = JSON.parse(b) as { login: string; password: string };
        res.setHeader("content-type", "application/json");
        if (/Headless/.test(req.headers["user-agent"] ?? "")) { res.statusCode = 403; res.end(JSON.stringify({ message: "navigateur refusé" })); return; }
        if (login !== "a@b.fr" || password !== "secret") { res.statusCode = 401; res.end(JSON.stringify({ message: "Identifiants incorrects" })); return; }
        res.setHeader("set-cookie", "sess=1; Path=/"); res.end(JSON.stringify({ token: "eyJabc.def.ghi" }));
      });
    } else if (u.pathname === "/auth") {
      let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
        const p = new URLSearchParams(b);
        if (p.get("pwd") !== "secret") { res.end(page(`<p>Erreur</p><form><input type="email"><input type="password"></form>`)); return; }
        res.statusCode = 302; res.setHeader("set-cookie", "sess=1; Path=/"); res.setHeader("location", "/v2/shift-details"); res.end();
      });
    } else if (u.pathname === "/v2/shift-details" && avecIframe) {
      res.end(page(`${menu}${iframe(avecExport ? "/pos/shift-details" : "/pos/vide")}`));
    } else if (u.pathname === "/v2/accounting" && avecIframe) {
      res.end(page(`${menu}${iframe(`/pos/accounting${u.search}`)}`));
    } else if (u.pathname === "/pos/vide") {
      res.end(page(`<p>Aucune donnée</p>`));
    } else if (u.pathname === "/pos/shift-details") {
      const s = u.searchParams.get("start"), e = u.searchParams.get("end");
      if (!s || !e) { res.statusCode = 302; res.setHeader("location", "/pos/shift-details?start=2026-10-06&end=2026-11-05"); res.end(); return; }
      res.end(page(`<p>Du ${frJ(s)} au ${frJ(e)}</p><button aria-label="Exporter" onclick="document.getElementById('fmt').style.display='block'"><svg width="16" height="16"></svg></button><div id="fmt" style="display:none"><a href="/export?start=${s}&end=${e}">Excel</a></div>`));
    } else if (u.pathname === "/pos/accounting") {
      const s = u.searchParams.get("start")!, e = u.searchParams.get("end")!;
      const oct = s === "2026-10-01";
      const contenu = `<h1>Du ${frJ(s)} au ${frJ(e)}</h1><table><tr><th>CA TTC net</th><th>TTC 5,5 %</th><th>TTC 10 %</th><th>TTC 20 %</th></tr><tr><td>${oct ? "200 324,25 €" : "1,00 €"}</td><td>4 272,00 €</td><td>194 680,25 €</td><td>1 372,00 €</td></tr></table>`;
      res.end(page(`<div id="h"></div><script>document.getElementById("h").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(contenu)};</script>`));
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
  port = (server.address() as { port: number }).port;
  process.env.LADDITION_URL = `http://127.0.0.1:${port}/`;
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
  await expect(extraireMois({ identifiant: "a@b.fr", motDePasse: "faux", mois: "2026-10" })).rejects.toThrow(/refuse/);
}, 90_000);

it.skipIf(!avecChrome)("robot : connexion par appel /v2/api/auth (401 lisible, espace en trop, e-mail en majuscules)", async () => {
  avecExport = true;
  connexionXhr = true;
  try {
    const { extraireMois, LadditionError } = await import("../ladditionBot");
    // Mot de passe enregistré avec une espace finale et e-mail avec majuscules (clavier du téléphone) : 2e/3e essai.
    const ok = await extraireMois({ identifiant: "A@b.fr", motDePasse: "secret ", mois: "2026-10", servicesSeulement: true });
    expect(ok.services?.length).toBe(SERVICES.filter(([j]) => j.startsWith("2026-10")).length);

    const e = await extraireMois({ identifiant: "a@b.fr", motDePasse: "faux", mois: "2026-10" }).catch((x) => x);
    expect(e).toBeInstanceOf(LadditionError);
    expect(e.message).toMatch(/refuse.*Identifiants incorrects/);
    const c = e.diagnostic.connexion;
    expect(c).toMatchObject({ identifiantRempli: true, motDePasseRempli: true, statut: 401, message: "Identifiants incorrects", essais: 1 });
    expect(c.champsEnvoyes).toEqual(["login", "password", "scope"]);
    expect(JSON.stringify(e.diagnostic)).not.toMatch(/faux/);
  } finally {
    connexionXhr = false;
  }
}, 120_000);

it("connexion : message d'erreur lisible, champs envoyés sans valeurs, variantes limitées", async () => {
  const { messageAuth, champsDuCorps, variantesConnexion } = await import("../ladditionBot");
  expect(messageAuth('{"message":"Invalid credentials","code":401}')).toBe("Invalid credentials · 401");
  expect(messageAuth('{"token":"eyJhbGciOi.eyJzdWIi.sig"}')).toBe("");
  expect(messageAuth("<html><body>Unauthorized</body></html>")).toBe("");
  expect(messageAuth("Accès refusé : eyJa.b.c")).toBe("Accès refusé : …");
  expect(champsDuCorps('{"login":"x","password":"y"}')).toEqual(["login", "password"]);
  expect(champsDuCorps("email=x&pwd=y")).toEqual(["email", "pwd"]);
  expect(champsDuCorps(undefined)).toEqual([]);
  expect(variantesConnexion("a@b.fr", "secret")).toEqual([{ identifiant: "a@b.fr", motDePasse: "secret" }]);
  expect(variantesConnexion("Tibs", "secret ")).toEqual([
    { identifiant: "Tibs", motDePasse: "secret " },
    { identifiant: "Tibs", motDePasse: "secret" },
  ]);
  expect(variantesConnexion(" A@b.fr", " secret")).toHaveLength(3);
  expect(variantesConnexion("x", "   ")).toEqual([{ identifiant: "x", motDePasse: "   " }]);
});

it.skipIf(!avecChrome)("robot : contenu dans une iframe d'un autre domaine (export en icône, CA/TVA en shadow DOM)", async () => {
  avecIframe = true;
  try {
    const { extraireMois } = await import("../ladditionBot");
    avecExport = true;
    const r = await extraireMois({ identifiant: "a@b.fr", motDePasse: "secret", mois: "2026-10" });
    expect(r.noteExport).toBeUndefined();
    expect(r.methode).toBe("export");
    expect(r.chiffres).toEqual(OCTOBRE);
    expect(r.diagnostic.cadres?.some((c) => c.includes("localhost"))).toBe(true);

    avecExport = false;
    const p = await extraireMois({ identifiant: "a@b.fr", motDePasse: "secret", mois: "2026-10" });
    expect(p.methode).toBe("page");
    expect(p.periodeConfirmee).toBe(true);
    expect(p.chiffres).toEqual(OCTOBRE);
  } finally {
    avecIframe = false;
    avecExport = true;
  }
}, 150_000);

it("diagnostic : filtres des API de rapports sans identifiants", async () => {
  const { resumeCorps } = await import("../ladditionBot");
  expect(resumeCorps('{"startDate":"2026-10-01","endDate":"2026-10-31","entityId":45799}')).toBe('{startDate="2026-10-01", endDate="2026-10-31", entityId=45799}');
  expect(resumeCorps('{"login":"a@b.fr","password":"x","refreshToken":"abc"}')).toBe("{login=…, password=…, refreshToken=…}");
  expect(resumeCorps("a=1")).toBe("");
  expect(resumeCorps(undefined)).toBe("");
});
