import "server-only";
import { bornesMois, extraireChiffres, type ChiffresCa } from "@/lib/laddition";

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
  diagnostic: Diagnostic;
}

export type Page = import("puppeteer-core").Page;

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

export async function diagnostic(page: Page, etape: string, appels: string[]): Promise<Diagnostic> {
  const texte = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  return {
    etape,
    url: urlSansSecret(page.url()),
    titre: await page.title().catch(() => ""),
    texte: texte.slice(0, 6000),
    appels: appels.slice(-40),
  };
}

/** Clique sur l'élément visible le plus petit dont le texte correspond. */
export async function cliquerTexte(page: Page, source: string): Promise<boolean> {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const candidats = [...document.querySelectorAll<HTMLElement>("a, button, [role=menuitem], [role=tab], [role=button], li, span, div, p")]
      .filter((el) => {
        const t = (el.innerText ?? "").trim();
        if (!t || t.length > 80 || !re.test(t)) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      })
      .sort((a, b) => a.innerText.length - b.innerText.length);
    // L'élément le plus profond : un conteneur qui contient un autre candidat est écarté.
    const el = candidats.find((c) => !candidats.some((o) => o !== c && c.contains(o)));
    if (!el) return false;
    (el.closest("a, button, [role=menuitem], [role=tab], [role=button]") as HTMLElement | null ?? el).click();
    return true;
  }, source);
}

export const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function calme(page: Page) {
  await page.waitForNetworkIdle({ idleTime: 800, timeout: 15_000 }).catch(() => {});
}

async function connexion(page: Page, identifiant: string, motDePasse: string, appels: string[]) {
  await page.goto(LADDITION_URL, { waitUntil: "networkidle2", timeout: 30_000 });
  const pwd = await page.waitForSelector("input[type=password]", { visible: true, timeout: 20_000 }).catch(() => null);
  if (!pwd) {
    // Déjà connecté (peu probable sans cookies) ou page de connexion inconnue.
    if (/login|connexion|signin/i.test(page.url())) throw new LadditionError("Page de connexion de L'Addition non reconnue.", await diagnostic(page, "connexion", appels));
    return;
  }
  const user = await page.$(
    [
      "input[type=email]",
      "input[autocomplete=username]",
      "input[name*=mail i]",
      "input[name*=user i]",
      "input[name*=login i]",
      "input[id*=mail i]",
      "input[id*=user i]",
      "input[type=text]",
    ].join(", "),
  );
  if (!user) throw new LadditionError("Champ identifiant introuvable sur la page de connexion.", await diagnostic(page, "connexion", appels));
  await user.click({ count: 3 });
  await user.type(identifiant, { delay: 20 });
  await pwd.click({ count: 3 });
  await pwd.type(motDePasse, { delay: 20 });
  await Promise.all([page.waitForNavigation({ timeout: 20_000 }).catch(() => {}), pwd.press("Enter")]);
  await calme(page);
  const encore = await page.$("input[type=password]");
  if (encore && (await encore.isVisible())) {
    const d = await diagnostic(page, "connexion", appels);
    throw new LadditionError("L'Addition a refusé la connexion : vérifie l'identifiant et le mot de passe dans Réglages.", d);
  }
}

/** Le texte de la page mentionne-t-il le mois demandé ? */
function moisAffiche(texte: string, mois: string): boolean {
  const [y, m] = mois.split("-");
  const { debut, fin } = bornesMois(mois);
  const fr = (iso: string) => iso.split("-").reverse().join("/");
  const nom = MOIS_FR[Number(m) - 1];
  return (
    texte.includes(fr(debut)) ||
    texte.includes(fr(fin)) ||
    texte.includes(debut) ||
    new RegExp(`${nom}\\s+${y}`, "i").test(texte) ||
    new RegExp(`01/${m}/${y.slice(2)}\\b`).test(texte)
  );
}

/** Essaie de choisir le mois : URL avec dates, sinon deux champs date visibles. */
async function choisirMois(page: Page, mois: string): Promise<boolean> {
  const texte = () => page.evaluate(() => document.body.innerText);
  if (moisAffiche(await texte(), mois)) return true;

  const url = urlPourMois(page.url(), mois);
  if (url) {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    await calme(page);
    if (moisAffiche(await texte(), mois)) return true;
  }

  const { debut, fin } = bornesMois(mois);
  const fr = (iso: string) => iso.split("-").reverse().join("/");
  const champs = await page.$$("input");
  const dates: { el: (typeof champs)[number]; iso: boolean }[] = [];
  for (const el of champs) {
    const info = await el.evaluate((i) => ({ type: i.type, value: i.value, visible: i.offsetParent !== null }));
    if (!info.visible) continue;
    if (info.type === "date") dates.push({ el, iso: true });
    else if (/^\d{2}\/\d{2}\/\d{4}/.test(info.value)) dates.push({ el, iso: false });
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
    await cliquerTexte(page, "^(valider|appliquer|rechercher|ok)$");
    await calme(page);
    if (moisAffiche(await texte(), mois)) return true;
  }
  return false;
}

export async function extraireMois(opts: { identifiant: string; motDePasse: string; etablissement?: string; mois: string }): Promise<Extraction> {
  const browser = await lancer();
  const appels: string[] = [];
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await page.setExtraHTTPHeaders({ "accept-language": "fr-FR,fr;q=0.9" });
    page.on("response", (r) => {
      const t = r.request().resourceType();
      if (t === "xhr" || t === "fetch") appels.push(`${r.request().method()} ${r.status()} ${urlSansSecret(r.url())}`);
    });

    await connexion(page, opts.identifiant, opts.motDePasse, appels);

    if (opts.etablissement) {
      await cliquerTexte(page, opts.etablissement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      await calme(page);
    }

    // Comptabilité > Comptabilité CA/TVA.
    await cliquerTexte(page, "^comptabilit[ée]s?$");
    await pause(800);
    const ok = await cliquerTexte(page, "CA\\s*/\\s*TVA");
    if (!ok) throw new LadditionError("Menu « Comptabilité CA/TVA » introuvable.", await diagnostic(page, "menu", appels));
    await calme(page);

    const periodeConfirmee = await choisirMois(page, opts.mois);
    const texte = await page.evaluate(() => document.body.innerText);
    return { chiffres: extraireChiffres(texte), periodeConfirmee, diagnostic: await diagnostic(page, "lecture", appels) };
  } catch (e) {
    if (e instanceof LadditionError) throw e;
    throw new LadditionError(`Robot L'Addition : ${(e as Error).message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
