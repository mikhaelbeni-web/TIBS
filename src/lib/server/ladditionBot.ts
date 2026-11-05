import "server-only";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { bornesMois, extraireChiffres, type ChiffresCa } from "@/lib/laddition";
import { chiffresDuMois, lignesXlsx, lireExportServices, periodeDuNom, problemeExport } from "@/lib/ladditionExport";

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
  /** export : fichier « Détails par service » téléchargé ; page : texte de Comptabilité CA/TVA. */
  methode: "export" | "page";
  /** Pourquoi l'export n'a pas servi, le cas échéant. */
  noteExport?: string;
  diagnostic: Diagnostic;
}

type Page = import("puppeteer-core").Page;

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

async function lancer() {
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

async function diagnostic(page: Page, etape: string, appels: string[]): Promise<Diagnostic> {
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
async function cliquerTexte(page: Page, source: string): Promise<boolean> {
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

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function calme(page: Page) {
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

/** Essaie de choisir le mois : URL avec dates, sinon deux champs date visibles. */
async function choisirMois(page: Page, mois: string, strict = false): Promise<boolean> {
  // Texte visible + valeurs des champs (sélecteurs de dates) + adresse de la page.
  const texte = () =>
    page.evaluate(
      () => `${document.body.innerText}\n${[...document.querySelectorAll("input")].map((i) => i.value).join("\n")}\n${decodeURIComponent(location.href)}`,
    );
  if (moisAffiche(await texte(), mois, strict)) return true;

  const url = urlPourMois(page.url(), mois);
  if (url) {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    await calme(page);
    if (moisAffiche(await texte(), mois, strict)) return true;
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
    if (moisAffiche(await texte(), mois, strict)) return true;
  }
  return false;
}

/**
 * Voie principale : page « détail des services » (/v2/shift-details), période = le mois, export Excel.
 * Le fichier donne exactement les chiffres de Comptabilité CA/TVA (vérifié sur octobre 2026). Sa période
 * (dans son nom, sinon les dates affichées sur la page) prouve que c'est bien le mois complet.
 */
async function parExport(page: Page, mois: string): Promise<{ chiffres: ChiffresCa } | { note: string }> {
  await page.goto(new URL("v2/shift-details", LADDITION_URL).toString(), { waitUntil: "networkidle2", timeout: 30_000 });
  await calme(page);
  const moisChoisi = await choisirMois(page, mois, true);

  const dossier = await mkdtemp(path.join(tmpdir(), "laddition-"));
  let recu: { nom: string; data: ArrayBuffer } | null = null;
  const surReponse = async (r: import("puppeteer-core").HTTPResponse) => {
    const type = r.headers()["content-type"] ?? "";
    if (!/spreadsheetml|ms-excel|octet-stream/i.test(type)) return;
    const dispo = r.headers()["content-disposition"] ?? "";
    const nom = decodeURIComponent(dispo.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1] ?? path.basename(new URL(r.url()).pathname));
    const buf = await r.buffer().catch(() => null);
    if (buf) recu = { nom, data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer };
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

    if (!(await cliquerTexte(page, "^(exporter|export|t[ée]l[ée]charger|excel)\\b"))) return { note: "bouton d'export introuvable" };
    await pause(800);
    await cliquerTexte(page, "^(excel|xlsx|format excel|exporter en excel)$");

    // Chrome peut enregistrer le fichier sous un autre nom : le nom d'origine (avec la période) vient de l'événement.
    for (let i = 0; i < 50 && !recu; i++) {
      const f = (await readdir(dossier)).find((n) => !n.endsWith(".crdownload"));
      if (f && termine) {
        const b = await readFile(path.join(dossier, f));
        recu = { nom: suggere || f, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
      } else await pause(500);
    }
    const fichier = recu as { nom: string; data: ArrayBuffer } | null;
    if (!fichier) return { note: "aucun fichier Excel reçu après l'export" };

    const exp = lireExportServices(await lignesXlsx(fichier.data));
    // Période : celle du nom du fichier, sinon celle affichée sur la page si le mois a bien été sélectionné.
    const periode = periodeDuNom(fichier.nom) ?? (moisChoisi ? bornesMois(mois) : null);
    const r = chiffresDuMois(exp, mois, periode);
    const pb = problemeExport(r, mois, periode) ?? (r.complet === null ? `période du fichier « ${fichier.nom} » inconnue` : null);
    return pb ? { note: pb } : { chiffres: r.chiffres };
  } catch (e) {
    return { note: (e as Error).message };
  } finally {
    page.off("response", surReponse);
    await rm(dossier, { recursive: true, force: true }).catch(() => {});
  }
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

    const exp = await parExport(page, opts.mois).catch((e: Error) => ({ note: e.message }));
    if ("chiffres" in exp) {
      return { chiffres: exp.chiffres, periodeConfirmee: true, methode: "export", diagnostic: await diagnostic(page, "export", appels) };
    }

    // Repli : Comptabilité > Comptabilité CA/TVA, lecture du texte de la page.
    await page.goto(LADDITION_URL, { waitUntil: "networkidle2", timeout: 30_000 }).catch(() => {});
    await cliquerTexte(page, "^comptabilit[ée]s?$");
    await pause(800);
    const ok = await cliquerTexte(page, "CA\\s*/\\s*TVA");
    if (!ok) throw new LadditionError(`Export : ${exp.note}. Menu « Comptabilité CA/TVA » introuvable.`, await diagnostic(page, "menu", appels));
    await calme(page);

    const periodeConfirmee = await choisirMois(page, opts.mois);
    const texte = await page.evaluate(() => document.body.innerText);
    return {
      chiffres: extraireChiffres(texte),
      periodeConfirmee,
      methode: "page",
      noteExport: exp.note,
      diagnostic: await diagnostic(page, "lecture", appels),
    };
  } catch (e) {
    if (e instanceof LadditionError) throw e;
    throw new LadditionError(`Robot L'Addition : ${(e as Error).message}`);
  } finally {
    await browser.close().catch(() => {});
  }
}
