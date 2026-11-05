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
async function parExport(page: Page, mois: string): Promise<{ chiffres: ChiffresCa; services: ServiceExport[] } | { note: string; services?: ServiceExport[] }> {
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
      if (t === "xhr" || t === "fetch") appels.push(`${r.request().method()} ${r.status()} ${urlSansSecret(r.url())}`);
    });

    await connexion(page, opts.identifiant, opts.motDePasse, appels);

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
