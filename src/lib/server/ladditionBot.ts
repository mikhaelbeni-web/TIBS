import "server-only";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bornesMois, extraireChiffres, type ChiffresCa } from "@/lib/laddition";
import { chiffresDuMois, lignesXlsx, lireExportServices, periodeDuNom, problemeExport, type ServiceExport } from "@/lib/ladditionExport";

/**
 * Robot qui ouvre L'Addition (reporting.laddition.com) dans un Chromium sans écran,
 * se connecte, va dans Comptabilité > Comptabilité CA/TVA, choisit le mois et lit les chiffres.
 *
 * L'Addition n'a pas d'API publique : le robot lit la page comme un humain. Si l'interface change,
 * l'extraction échoue proprement et renvoie un diagnostic (adresse, texte visible, appels réseau)
 * pour corriger les sélecteurs, sans jamais inclure le mot de passe.
 */
export const LADDITION_URL = process.env.LADDITION_URL || "https://reporting.laddition.com/";

export interface Diagnostic {
  etape: string;
  url: string;
  titre: string;
  texte: string;
  appels: string[];
  /** Adresses des cadres (iframes) de la page, le principal d'abord. */
  cadres?: string[];
  /** Forme des réponses JSON des API de rapports (clés seulement), pour adapter le robot. */
  structures?: string[];
  /** Demandes de L'Addition dont le robot a remplacé la période par le mois voulu. */
  periodeForcee?: number;
  /** Page « détail des services » quand l'export n'a pas abouti. */
  export?: { note: string; url: string; cadres: string[]; texte: string };
  /** Contrôles de la connexion, sans aucune valeur saisie. */
  connexion?: ControleConnexion;
}

export interface ControleConnexion {
  identifiantRempli: boolean;
  motDePasseRempli: boolean;
  /** « e-mail » ou « identifiant », et sa longueur. */
  identifiant: string;
  /** Réponse de L'Addition à l'appel d'authentification. */
  statut?: number;
  message?: string;
  /** Noms des champs envoyés (jamais leurs valeurs). */
  champsEnvoyes?: string[];
  /** Message d'erreur affiché sous le formulaire. */
  erreurAffichee?: string;
  essais: number;
}

/** Message lisible d'une réponse d'erreur d'authentification, sans jeton. */
export function messageAuth(corps: string): string {
  let texte = corps;
  try {
    const j = JSON.parse(corps) as Record<string, unknown> & { errors?: { message?: unknown }[] };
    texte = [j.message, j.error, j.error_description, j.detail, j.code, j.errors?.[0]?.message]
      .filter((v) => typeof v === "string" || typeof v === "number")
      .join(" · ");
  } catch {
    if (/^\s*</.test(corps)) texte = "";
  }
  return texte
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]*/g, "…")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Résumé d'un corps JSON envoyé aux API de rapports (filtres : dates, établissement) pour le diagnostic.
 * Les valeurs des champs sensibles sont masquées, chaque valeur est tronquée.
 */
export function resumeCorps(corps: string | undefined): string {
  if (!corps) return "";
  let j: unknown;
  try {
    j = JSON.parse(corps);
  } catch {
    return "";
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return "";
  const parties = Object.entries(j as Record<string, unknown>).map(([k, v]) =>
    /token|pass|pwd|secret|auth|login|user|mail|identifiant|code/i.test(k) ? `${k}=…` : `${k}=${(JSON.stringify(v) ?? "").slice(0, 60)}`,
  );
  return `{${parties.join(", ")}}`.slice(0, 300);
}

const DEBUT_CLE = /open|start|begin|from|debut|min/i;
const FIN_CLE = /clos|end|until|fin\b|max|(^|_)to$/i;

function reecrireObjet(o: Record<string, unknown>, debut: string, fin: string, prof: number): boolean {
  let change = false;
  for (const [k, v] of Object.entries(o)) {
    if (v && typeof v === "object" && !Array.isArray(v) && prof < 3) {
      change = reecrireObjet(v as Record<string, unknown>, debut, fin, prof + 1) || change;
      continue;
    }
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) continue;
    const borne = DEBUT_CLE.test(k) ? debut : FIN_CLE.test(k) ? fin : null;
    if (!borne || v.startsWith(borne)) continue;
    o[k] = borne + v.slice(10);
    change = true;
  }
  return change;
}

/**
 * Remplace les dates d'un corps JSON (opening_date, closing_date, start…, end…) par les bornes voulues
 * (AAAA-MM-JJ), en gardant l'heure. null si rien à changer.
 */
export function reecrirePeriode(corps: string, debut: string, fin: string): string | null {
  let j: unknown;
  try {
    j = JSON.parse(corps);
  } catch {
    return null;
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  return reecrireObjet(j as Record<string, unknown>, debut, fin, 0) ? JSON.stringify(j) : null;
}

/** Même chose pour les paramètres datés d'une adresse. null si rien à changer. */
export function reecrireUrlPeriode(u: string, debut: string, fin: string): string | null {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  const o = Object.fromEntries(url.searchParams.entries());
  if (!reecrireObjet(o, debut, fin, 3)) return null;
  for (const [k, v] of Object.entries(o)) url.searchParams.set(k, String(v));
  return url.toString();
}

/** Forme d'une valeur JSON : clés seulement (les liens sont signalés), jamais les valeurs. */
export function decrireJson(v: unknown, prof = 0): string {
  if (Array.isArray(v)) return `[${v.length} × ${v.length ? decrireJson(v[0], prof + 1) : "?"}]`;
  if (v && typeof v === "object") {
    if (prof >= 4) return "{…}";
    const cles = Object.entries(v as Record<string, unknown>)
      .slice(0, 30)
      .map(([k, x]) => (x && typeof x === "object" ? `${k}:${decrireJson(x, prof + 1)}` : typeof x === "string" && /^https?:\/\//.test(x) ? `${k}(lien)` : k));
    return `{${cles.join(", ")}}`;
  }
  return typeof v;
}

/** API de rapports de L'Addition (reporting-pos…), hors authentification. */
export function estApiRapports(u: string): boolean {
  try {
    const url = new URL(u);
    const hote = url.hostname;
    const laddition = hote.endsWith(".laddition.com") && hote !== "auth.laddition.com";
    const local = hote === "127.0.0.1" || hote === "localhost";
    return (laddition || local) && /^\/api\//.test(url.pathname) && !/^\/api\/auth\b/.test(url.pathname) && !/^\/v2\/api\//.test(url.pathname);
  } catch {
    return false;
  }
}

/** Noms des champs d'un corps JSON ou formulaire, sans les valeurs. */
export function champsDuCorps(corps: string | undefined): string[] {
  if (!corps) return [];
  try {
    const j = JSON.parse(corps);
    if (j && typeof j === "object" && !Array.isArray(j)) return Object.keys(j).slice(0, 20);
  } catch {
    /* formulaire */
  }
  return [...new URLSearchParams(corps).keys()].filter((k) => /^[\w.[\]-]{1,40}$/.test(k)).slice(0, 20);
}

export class LadditionError extends Error {
  constructor(
    message: string,
    public diagnostic?: Diagnostic,
  ) {
    super(message);
  }
}

export interface Extraction {
  chiffres: Record<keyof ChiffresCa, number | null>;
  periodeConfirmee: boolean;
  /** export : fichier « Détails par service » téléchargé ; page : texte de Comptabilité CA/TVA. */
  methode: "export" | "page";
  /** Pourquoi l'export n'a pas servi, le cas échéant. */
  noteExport?: string;
  /** Services lus dans l'export (CB, espèces, Uber, lien du ticket Z), même si le mois n'est pas complet. */
  services?: ServiceExport[];
  diagnostic: Diagnostic;
}

export type Page = import("puppeteer-core").Page;
type Frame = import("puppeteer-core").Frame;

const MOIS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** Retire les valeurs des paramètres sensibles d'une URL (jetons, sessions). */
export function urlSansSecret(u: string): string {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (/token|auth|session|key|pass|sig/i.test(k)) url.searchParams.set(k, "…");
    }
    return url.toString().slice(0, 300);
  } catch {
    return u.slice(0, 300);
  }
}

/** Remplace la première et la dernière date AAAA-MM-JJ (ou JJ/MM/AAAA) d'une URL par les bornes du mois. */
export function urlPourMois(u: string, mois: string): string | null {
  const { debut, fin } = bornesMois(mois);
  const fr = (iso: string) => iso.split("-").reverse().join("/");
  for (const [re, fmt] of [
    [/\d{4}-\d{2}-\d{2}/g, (s: string) => s],
    [/\d{2}(?:\/|%2F)\d{2}(?:\/|%2F)\d{4}/gi, (s: string) => fr(s)],
  ] as const) {
    const found = [...u.matchAll(re)];
    if (found.length >= 2) {
      const first = found[0], last = found[found.length - 1];
      const enc = (s: string, orig: string) => (orig.includes("%2F") || orig.includes("%2f") ? s.replace(/\//g, "%2F") : s);
      return (
        u.slice(0, first.index) +
        enc(fmt(debut), first[0]) +
        u.slice(first.index! + first[0].length, last.index) +
        enc(fmt(fin), last[0]) +
        u.slice(last.index! + last[0].length)
      );
    }
  }
  return null;
}

export async function lancer() {
  const chromium = (await import("@sparticuz/chromium")).default;
  const puppeteer = (await import("puppeteer-core")).default;
  chromium.setGraphicsMode = false;
  const local = process.env.CHROME_PATH; // développement : un Chrome installé
  return puppeteer.launch({
    args: local ? ["--no-sandbox"] : await puppeteer.defaultArgs({ args: chromium.args, headless: "shell" }),
    executablePath: local || (await chromium.executablePath()),
    headless: "shell",
    defaultViewport: { width: 1366, height: 900 },
  });
}

/**
 * Cadres de la page : L'Addition affiche ses pages (CA/TVA, détail des services) dans des iframes
 * d'un autre domaine. contenuDabord : les iframes avant le cadre principal (le menu).
 */
export function cadres(page: Page, contenuDabord = false): Frame[] {
  const principal = page.mainFrame();
  const autres = page.frames().filter((f) => f !== principal && !f.detached);
  return contenuDabord ? [...autres, principal] : [principal, ...autres];
}

/** Texte visible de tous les cadres (shadow DOM compris) ; avecChamps : valeurs des champs et adresse en plus. */
export async function texteDesCadres(page: Page, avecChamps = false): Promise<string> {
  const morceaux: string[] = [];
  for (const f of cadres(page)) {
    const t = await f
      .evaluate((champs) => {
        const racines: (Document | ShadowRoot)[] = [document];
        for (let i = 0; i < racines.length; i++) for (const el of racines[i].querySelectorAll("*")) if (el.shadowRoot) racines.push(el.shadowRoot);
        const textes = [document.body?.innerText ?? ""];
        for (const r of racines.slice(1)) textes.push([...r.children].map((c) => (c as HTMLElement).innerText ?? c.textContent ?? "").join("\n"));
        if (champs) {
          textes.push(racines.flatMap((r) => [...r.querySelectorAll("input")]).map((i) => i.value).join("\n"));
          textes.push(decodeURIComponent(location.href));
        }
        return textes.filter((x) => x.trim()).join("\n");
      }, avecChamps)
      .catch(() => "");
    if (t.trim()) morceaux.push(t);
  }
  return morceaux.join("\n");
}

interface Suivi {
  structures: Map<string, string>;
  periodeForcee: number;
  /** Bornes AAAA-MM-JJ imposées aux API de rapports. */
  periode?: { debut: string; fin: string };
  export?: Diagnostic["export"];
}
const suivis = new WeakMap<Page, Suivi>();
function suivi(page: Page): Suivi {
  let x = suivis.get(page);
  if (!x) suivis.set(page, (x = { structures: new Map(), periodeForcee: 0 }));
  return x;
}

/** Les prochaines demandes des API de rapports porteront sur ce mois (compteur remis à zéro). */
function imposerPeriode(page: Page, mois: string) {
  const x = suivi(page);
  x.periode = bornesMois(mois);
  x.periodeForcee = 0;
}

/**
 * Le sélecteur de dates de L'Addition 3.x n'est pas pilotable de façon sûre : le robot laisse la page
 * faire ses demandes et remplace leur période (opening_date / closing_date…) par le mois voulu.
 * Note aussi la forme des réponses JSON pour le diagnostic.
 */
async function suivreApi(page: Page) {
  const x = suivi(page);
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const per = x.periode;
    if (per && estApiRapports(req.url())) {
      const corps = req.postData();
      const nouveauCorps = corps ? reecrirePeriode(corps, per.debut, per.fin) : null;
      const nouvelleUrl = reecrireUrlPeriode(req.url(), per.debut, per.fin);
      if (nouveauCorps || nouvelleUrl) {
        x.periodeForcee++;
        void req.continue({ ...(nouveauCorps ? { postData: nouveauCorps } : {}), ...(nouvelleUrl ? { url: nouvelleUrl } : {}) }).catch(() => {});
        return;
      }
    }
    void req.continue().catch(() => {});
  });
  page.on("response", async (r) => {
    if (!r.ok() || !estApiRapports(r.url()) || !/json/i.test(r.headers()["content-type"] ?? "")) return;
    const chemin = new URL(r.url()).pathname;
    if (x.structures.has(chemin) || x.structures.size >= 10) return;
    const j: unknown = await r.json().catch(() => undefined);
    if (j !== undefined) x.structures.set(chemin, `${r.request().method()} ${chemin} → ${decrireJson(j)}`.slice(0, 700));
  });
}

export async function diagnostic(page: Page, etape: string, appels: string[]): Promise<Diagnostic> {
  const texte = await texteDesCadres(page);
  const x = suivis.get(page);
  return {
    etape,
    url: urlSansSecret(page.url()),
    titre: await page.title().catch(() => ""),
    texte: texte.slice(0, 6000),
    cadres: cadres(page).map((f) => urlSansSecret(f.url())).slice(0, 10),
    ...(x?.structures.size ? { structures: [...x.structures.values()] } : {}),
    ...(x?.periode ? { periodeForcee: x.periodeForcee } : {}),
    ...(x?.export ? { export: x.export } : {}),
    appels: appels.slice(-40),
  };
}

/**
 * Clique sur l'élément visible le plus petit dont le texte (ou, pour un bouton-icône, aria-label / title)
 * correspond, dans le premier cadre qui en a un. Shadow DOM compris.
 */
export async function cliquerTexte(page: Page, source: string, contenuDabord = false): Promise<boolean> {
  for (const f of cadres(page, contenuDabord)) {
    const ok = await f
      .evaluate((src) => {
        const re = new RegExp(src, "i");
        const racines: (Document | ShadowRoot)[] = [document];
        for (let i = 0; i < racines.length; i++) for (const el of racines[i].querySelectorAll("*")) if (el.shadowRoot) racines.push(el.shadowRoot);
        const libelle = (el: HTMLElement) => (el.innerText ?? "").trim() || (el.getAttribute("aria-label") ?? "").trim() || (el.getAttribute("title") ?? "").trim();
        const candidats = racines
          .flatMap((r) => [...r.querySelectorAll<HTMLElement>("a, button, [role=menuitem], [role=tab], [role=button], li, span, div, p")])
          .filter((el) => {
            const t = libelle(el);
            if (!t || t.length > 80 || !re.test(t)) return false;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .sort((a, b) => libelle(a).length - libelle(b).length);
        // L'élément le plus profond : un conteneur qui contient un autre candidat est écarté.
        const el = candidats.find((c) => !candidats.some((o) => o !== c && c.contains(o)));
        if (!el) return false;
        (el.closest("a, button, [role=menuitem], [role=tab], [role=button]") as HTMLElement | null ?? el).click();
        return true;
      }, source)
      .catch(() => false);
    if (ok) return true;
  }
  return false;
}

/** Attend que des dates ou des montants s'affichent (les iframes se remplissent après le menu). */
export async function attendreContenu(page: Page, ms = 8_000) {
  const fin = Date.now() + ms;
  while (Date.now() < fin) {
    if (/\d{2}\/\d{2}\/\d{2,4}|\d,\d{2}\s*€/.test(await texteDesCadres(page))) return;
    await pause(500);
  }
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function calme(page: Page) {
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 15_000 }).catch(() => {});
}

type Champ = import("puppeteer-core").ElementHandle<HTMLInputElement>;

/** Champ identifiant : le dernier champ de saisie visible avant le mot de passe (sinon le premier visible). */
async function champIdentifiant(pwd: Champ): Promise<Champ | null> {
  const h = await pwd.evaluateHandle((p) => {
    const visibles = [...document.querySelectorAll<HTMLInputElement>("input")].filter((i) => {
      if (i === p || /^(hidden|password|checkbox|radio|submit|button|file|image|reset)$/i.test(i.type)) return false;
      const r = i.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(i).visibility !== "hidden";
    });
    const avant = visibles.filter((i) => i.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING);
    return avant[avant.length - 1] ?? visibles[0] ?? null;
  });
  const el = h.asElement() as Champ | null;
  if (!el) await h.dispose();
  return el;
}

/** Tape la valeur puis vérifie qu'elle est bien dans le champ (sans jamais la relire côté serveur). */
async function remplir(champ: Champ, valeur: string): Promise<boolean> {
  await champ.click({ count: 3 });
  await champ.evaluate((i) => i.select());
  await champ.type(valeur, { delay: 25 });
  if (await champ.evaluate((i, v) => i.value === v, valeur)) return true;
  // Champ contrôlé (React) qui a perdu des touches : valeur posée par le setter natif, puis événements.
  await champ.evaluate((i, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(i, v);
    i.dispatchEvent(new Event("input", { bubbles: true }));
    i.dispatchEvent(new Event("change", { bubbles: true }));
  }, valeur);
  return champ.evaluate((i, v) => i.value === v, valeur);
}

/**
 * Variantes à essayer, dans l'ordre : telles qu'enregistrées, puis sans espace autour du mot de passe
 * et e-mail en minuscules (claviers de téléphone). Au plus 3 essais pour ne pas bloquer le compte.
 */
export function variantesConnexion(identifiant: string, motDePasse: string): { identifiant: string; motDePasse: string }[] {
  const id = identifiant.trim();
  const ids = [id, ...(id.includes("@") ? [id.toLowerCase()] : [])];
  const mdps = [motDePasse, motDePasse.trim()];
  const vues = new Set<string>();
  const out: { identifiant: string; motDePasse: string }[] = [];
  for (const [i, m] of [
    [ids[0], mdps[0]],
    [ids[0], mdps[1]],
    [ids[ids.length - 1], mdps[1]],
  ]) {
    const cle = JSON.stringify([i, m]);
    if (!i || !m || vues.has(cle)) continue;
    vues.add(cle);
    out.push({ identifiant: i, motDePasse: m });
  }
  return out;
}

const APPEL_AUTH = /\/api\/auth|\/login|\/signin|\/token|\/session/i;

async function connexion(page: Page, identifiant: string, motDePasse: string, appels: string[]) {
  // Chrome sans écran s'annonce « HeadlessChrome » : certains sites refusent ces navigateurs.
  await page.setUserAgent({ userAgent: (await page.browser().userAgent()).replace(/Headless/g, "") });
  await page.goto(LADDITION_URL, { waitUntil: "networkidle2", timeout: 30_000 });
  const id = identifiant.trim();
  const controle: ControleConnexion = {
    identifiantRempli: false,
    motDePasseRempli: false,
    identifiant: `${id.includes("@") ? "e-mail" : "identifiant"}, ${id.length} caractères`,
    essais: 0,
  };
  const echec = async (message: string) => {
    const d = await diagnostic(page, "connexion", appels);
    throw new LadditionError(message, { ...d, connexion: controle });
  };

  for (const v of variantesConnexion(identifiant, motDePasse)) {
    const pwd = (await page.waitForSelector("input[type=password]", { visible: true, timeout: 20_000 }).catch(() => null)) as Champ | null;
    if (!pwd) {
      if (controle.essais > 0) return; // le formulaire a disparu : connecté
      // Déjà connecté (peu probable sans cookies) ou page de connexion inconnue.
      if (/login|connexion|signin|auth\./i.test(page.url())) await echec("Page de connexion de L'Addition non reconnue.");
      return;
    }
    const user = await champIdentifiant(pwd);
    if (!user) return echec("Champ identifiant introuvable sur la page de connexion.");
    controle.essais++;
    controle.identifiantRempli = await remplir(user, v.identifiant);
    controle.motDePasseRempli = await remplir(pwd, v.motDePasse);
    if (!controle.identifiantRempli || !controle.motDePasseRempli) return echec("Le robot n'arrive pas à remplir le formulaire de connexion de L'Addition.");

    const reponse = page.waitForResponse((r) => r.request().method() === "POST" && APPEL_AUTH.test(r.url()), { timeout: 20_000 }).catch(() => null);
    const navigation = page.waitForNavigation({ timeout: 20_000 }).catch(() => {});
    await pwd.press("Enter");
    const r = await reponse;
    if (r) {
      controle.statut = r.status();
      controle.champsEnvoyes = champsDuCorps(r.request().postData());
      controle.message = r.ok() ? undefined : messageAuth(await r.text().catch(() => "")) || undefined;
    }
    if (!r || r.ok()) await navigation;
    await calme(page);
    const encore = await page.$("input[type=password]");
    if (!encore || !(await encore.isVisible())) return;
    controle.erreurAffichee =
      (await page
        .evaluate(() =>
          [...document.querySelectorAll<HTMLElement>("[role=alert], .Mui-error, .MuiFormHelperText-root, .MuiAlert-message, [class*=error i], [class*=alert i], [class*=toast i]")]
            .map((e) => e.innerText.trim())
            .filter(Boolean)
            .join(" · ")
            .slice(0, 200),
        )
        .catch(() => "")) || undefined;
    // 401/403 : identifiants refusés, on tente la variante suivante ; autre erreur : inutile d'insister.
    if (r && r.status() !== 401 && r.status() !== 403) break;
  }

  const raison = controle.message || controle.erreurAffichee;
  // Formulaire toujours affiché après envoi : refus (401/403, ou pas d'appel d'authentification repéré).
  if (controle.statut === undefined || controle.statut === 401 || controle.statut === 403) {
    return echec(
      `L'Addition refuse l'identifiant ou le mot de passe enregistrés dans Réglages${raison ? ` (« ${raison} »)` : ""}. ` +
        "Connecte-toi toi-même sur auth.laddition.com avec exactement les mêmes, puis ressaisis-les dans Réglages.",
    );
  }
  return echec(`La connexion à L'Addition n'a pas abouti${controle.statut ? ` (réponse ${controle.statut})` : ""}${raison ? ` : ${raison}` : ""}.`);
}

/**
 * Le texte de la page mentionne-t-il le mois demandé ?
 * strict : le premier ET le dernier jour du mois doivent apparaître (un « 6 octobre 2026 – 5 novembre 2026 »
 * ne doit pas passer pour octobre complet).
 */
export function moisAffiche(texte: string, mois: string, strict = false): boolean {
  const [y, m] = mois.split("-");
  const { debut, fin } = bornesMois(mois);
  const fr = (iso: string) => iso.split("-").reverse().join("/");
  const court = (iso: string) => fr(iso).slice(0, 6) + iso.slice(2, 4);
  const present = (iso: string) => texte.includes(iso) || texte.includes(fr(iso)) || new RegExp(`${court(iso)}\\b`).test(texte);
  if (strict) return present(debut) && present(fin);
  const nom = MOIS_FR[Number(m) - 1];
  return (
    texte.includes(fr(debut)) ||
    texte.includes(fr(fin)) ||
    texte.includes(debut) ||
    new RegExp(`${nom}\\s+${y}`, "i").test(texte) ||
    new RegExp(`01/${m}/${y.slice(2)}\\b`).test(texte)
  );
}

/** Essaie de choisir le mois : URL datée (de la page ou de son iframe), sinon deux champs date visibles. */
async function choisirMois(page: Page, mois: string, strict = false): Promise<boolean> {
  // Texte visible + valeurs des champs (sélecteurs de dates) + adresses, dans tous les cadres.
  const texte = () => texteDesCadres(page, true);
  await attendreContenu(page);
  if (moisAffiche(await texte(), mois, strict)) return true;

  // La micro-app intégrée porte souvent la période dans sa propre adresse.
  for (const f of cadres(page, true)) {
    const url = urlPourMois(f.url(), mois);
    if (!url) continue;
    if (f === page.mainFrame()) await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    else await f.goto(url, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    await calme(page);
    await attendreContenu(page, 4_000);
    if (moisAffiche(await texte(), mois, strict)) return true;
    break;
  }

  const { debut, fin } = bornesMois(mois);
  const fr = (iso: string) => iso.split("-").reverse().join("/");
  type Champ = import("puppeteer-core").ElementHandle<HTMLInputElement>;
  let dates: { el: Champ; iso: boolean }[] = [];
  for (const f of cadres(page, true)) {
    dates = [];
    for (const el of await f.$$<"input">("input").catch(() => [] as Champ[])) {
      const info = await el.evaluate((i) => ({ type: i.type, value: i.value, visible: i.offsetParent !== null })).catch(() => null);
      if (!info?.visible) continue;
      if (info.type === "date") dates.push({ el, iso: true });
      else if (/^\d{2}\/\d{2}\/\d{4}/.test(info.value)) dates.push({ el, iso: false });
    }
    if (dates.length >= 2) break;
  }
  if (dates.length >= 2) {
    const pairs = [
      [dates[0], debut],
      [dates[dates.length - 1], fin],
    ] as const;
    for (const [{ el, iso }, v] of pairs) {
      await el.click({ count: 3 });
      await el.type(iso ? v : fr(v), { delay: 30 });
      await el.press("Enter");
    }
    await page.keyboard.press("Escape").catch(() => {});
    await cliquerTexte(page, "^(valider|appliquer|rechercher|ok)$", true);
    await calme(page);
    await attendreContenu(page, 4_000);
    if (moisAffiche(await texte(), mois, strict)) return true;
  }
  return false;
}

/**
 * Voie principale : page « détail des services » (/v2/shift-details), période = le mois, export Excel.
 * Le fichier donne exactement les chiffres de Comptabilité CA/TVA (vérifié sur octobre 2026). Sa période
 * (dans son nom, sinon les dates affichées sur la page) prouve que c'est bien le mois complet.
 */
async function parExport(page: Page, mois: string): Promise<{ chiffres: ChiffresCa; services: ServiceExport[] } | { note: string; services?: ServiceExport[] }> {
  const r = await parExportBrut(page, mois);
  if ("note" in r) {
    suivi(page).export = {
      note: r.note,
      url: urlSansSecret(page.url()),
      cadres: cadres(page).map((f) => urlSansSecret(f.url())).slice(0, 10),
      texte: (await texteDesCadres(page)).slice(0, 2500),
    };
  }
  return r;
}

async function parExportBrut(page: Page, mois: string): Promise<{ chiffres: ChiffresCa; services: ServiceExport[] } | { note: string; services?: ServiceExport[] }> {
  imposerPeriode(page, mois);
  await page.goto(new URL("v2/shift-details", LADDITION_URL).toString(), { waitUntil: "networkidle2", timeout: 30_000 });
  await calme(page);
  // Période imposée aux demandes de la page : le mois est sélectionné même si le texte affiché ne le dit pas.
  const moisChoisi = (await choisirMois(page, mois, true)) || suivi(page).periodeForcee > 0;

  const dossier = await mkdtemp(path.join(tmpdir(), "laddition-"));
  let recu: { nom: string; data: ArrayBuffer } | null = null;
  // Nom donné par le serveur (avec la période), même si le corps n'est lisible que par le téléchargement.
  let nomServeur = "";
  const surReponse = async (r: import("puppeteer-core").HTTPResponse) => {
    const type = r.headers()["content-type"] ?? "";
    if (!/spreadsheetml|ms-excel|octet-stream/i.test(type)) return;
    const dispo = r.headers()["content-disposition"] ?? "";
    const nom = decodeURIComponent(dispo.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? path.basename(new URL(r.url()).pathname));
    nomServeur ||= nom;
    const buf = await r.buffer().catch(() => null);
    // Corps vide : demande interceptée ou fichier remis à la page (blob) ; le téléchargement prend le relais.
    if (buf?.length) recu = { nom, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
  };
  page.on("response", surReponse);
  try {
    // Les téléchargements se règlent au niveau du navigateur (une session CDP de page ne suffit pas).
    const cdp = await page.browser().target().createCDPSession();
    let suggere = "";
    let termine = false;
    cdp.on("Browser.downloadWillBegin", (e) => (suggere = e.suggestedFilename));
    cdp.on("Browser.downloadProgress", (e) => (termine ||= e.state === "completed"));
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dossier, eventsEnabled: true });

    if (!(await cliquerTexte(page, "^(exporter|export|t[ée]l[ée]charger|excel)\\b", true))) return { note: "bouton d'export introuvable" };
    await pause(800);
    await cliquerTexte(page, "^(excel|xlsx|format excel|exporter en excel)$", true);

    // Chrome peut enregistrer le fichier sous un autre nom : le nom d'origine (avec la période) vient de l'événement.
    for (let i = 0; i < 50 && !recu; i++) {
      const f = (await readdir(dossier)).find((n) => !n.endsWith(".crdownload"));
      if (f && termine) {
        const b = await readFile(path.join(dossier, f));
        const nom = [nomServeur, suggere, f].find((n) => n && periodeDuNom(n)) ?? (suggere || f);
        recu = { nom, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
      } else await pause(500);
    }
    const fichier = recu as { nom: string; data: ArrayBuffer } | null;
    if (!fichier) return { note: "aucun fichier Excel reçu après l'export" };

    const exp = lireExportServices(await lignesXlsx(fichier.data));
    // Période : celle du nom du fichier, sinon celle affichée sur la page si le mois a bien été sélectionné.
    const periode = periodeDuNom(fichier.nom) ?? (moisChoisi ? bornesMois(mois) : null);
    const r = chiffresDuMois(exp, mois, periode);
    const pb = problemeExport(r, mois, periode) ?? (r.complet === null ? `période du fichier « ${fichier.nom} » inconnue` : null);
    return pb ? { note: pb, services: exp.services } : { chiffres: r.chiffres, services: exp.services };
  } catch (e) {
    return { note: (e as Error).message };
  } finally {
    page.off("response", surReponse);
    await rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
}

export async function extraireMois(opts: {
  identifiant: string;
  motDePasse: string;
  etablissement?: string;
  mois: string;
  /** Ne veut que les services de l'export (pas de repli sur la page CA/TVA). */
  servicesSeulement?: boolean;
}): Promise<Extraction> {
  const browser = await lancer();
  const appels: string[] = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await page.setExtraHTTPHeaders({ "accept-language": "fr-FR,fr;q=0.9" });
    page.on("response", (r) => {
      const t = r.request().resourceType();
      if (t !== "xhr" && t !== "fetch") return;
      // Filtres envoyés aux API de rapports (dates, établissement), jamais les identifiants.
      const corps = /^https?:\/\/reporting[\w-]*\.laddition\.com\//.test(r.url()) ? resumeCorps(r.request().postData()) : "";
      appels.push(`${r.request().method()} ${r.status()} ${urlSansSecret(r.url())}${corps ? ` ${corps}` : ""}`);
    });

    await connexion(page, opts.identifiant, opts.motDePasse, appels);
    await suivreApi(page);

    if (opts.etablissement) {
      await cliquerTexte(page, opts.etablissement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      await calme(page);
    }

    const exp: { chiffres?: ChiffresCa; note?: string; services?: ServiceExport[] } = await parExport(page, opts.mois).catch((e: Error) => ({ note: e.message }));
    if (exp.chiffres) {
      return { chiffres: exp.chiffres, periodeConfirmee: true, methode: "export", services: exp.services, diagnostic: await diagnostic(page, "export", appels) };
    }
    // Mois en cours : l'export est partiel (pas de chiffres du mois) mais ses services servent au pointage jour à jour.
    if (opts.servicesSeulement) {
      if (exp.services) return { chiffres: { caTtcNet: null, ttc10: null, ttc20: null, ttc55: null }, periodeConfirmee: false, methode: "export", noteExport: exp.note, services: exp.services, diagnostic: await diagnostic(page, "export", appels) };
      throw new LadditionError(`Export « Détails par service » : ${exp.note ?? "échec"}.`, await diagnostic(page, "export", appels));
    }

    // Repli : Comptabilité CA/TVA (/v2/vat-family), en accès direct, sinon par le menu ; lecture du texte.
    imposerPeriode(page, opts.mois);
    await page.goto(new URL("v2/vat-family", LADDITION_URL).toString(), { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    await calme(page);
    await attendreContenu(page);
    if (!/TTC/i.test(await texteDesCadres(page))) {
      await page.goto(LADDITION_URL, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
      await cliquerTexte(page, "^comptabilit[ée]s?$");
      await pause(800);
      const ok = await cliquerTexte(page, "CA\\s*/\\s*TVA");
      if (!ok) throw new LadditionError(`Export : ${exp.note}. Menu « Comptabilité CA/TVA » introuvable.`, await diagnostic(page, "menu", appels));
      await calme(page);
    }

    const periodeConfirmee = (await choisirMois(page, opts.mois)) || suivi(page).periodeForcee > 0;
    const texte = await texteDesCadres(page);
    return {
      chiffres: extraireChiffres(texte),
      periodeConfirmee,
      methode: "page",
      noteExport: exp.note,
      services: exp.services,
      diagnostic: await diagnostic(page, "lecture", appels),
    };
  } catch (e) {
    if (e instanceof LadditionError) throw e;
    throw new LadditionError(`Robot L'Addition : ${(e as Error).message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
