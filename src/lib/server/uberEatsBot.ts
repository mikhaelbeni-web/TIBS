import "server-only";
import { lireCopieUber, type LigneUber } from "@/lib/contestations";
import { antiRobot, codeUberDepuisMail, contestationConfirmee, demandeCode, ligneDeLaBoutique, montantRetenu, UBER_MANAGER_URL } from "@/lib/uberEats";
import { bodyText, header } from "@/lib/mail";
import { getMessage, listMessageIds } from "@/lib/server/google";
import { calme, cliquerTexte, diagnostic, lancer, pause, urlSansSecret, type Diagnostic, type Page } from "@/lib/server/ladditionBot";

/**
 * Robot Uber Eats Manager : se connecte avec les identifiants du restaurant, lit la liste des commandes
 * avec un problème, ouvre une commande pour lire le montant retenu, et envoie une contestation.
 *
 * Uber n'a pas d'API publique pour cela : le robot lit la page comme un humain. Chaque échec renvoie un
 * diagnostic (adresse, texte visible, capture d'écran) pour corriger les sélecteurs, jamais le mot de passe.
 * La session (cookies) est gardée chiffrée pour éviter un code de vérification à chaque passage.
 */

export interface DiagnosticUber extends Diagnostic {
  capture?: string; // JPEG en base64
}

export type BesoinUber = "identifiants" | "code_sms" | "code_mail" | "anti_robot" | "page_inconnue";

export class UberError extends Error {
  constructor(
    message: string,
    public diagnostic?: DiagnosticUber,
    public besoin?: BesoinUber,
  ) {
    super(message);
  }
}

export interface ConfigUber {
  email: string;
  motDePasse: string;
  urlProblemes?: string;
  boutique?: string;
  cookies?: string; // JSON des cookies de la dernière session
  /** Jeton Gmail de la boîte du restaurant, pour lire le code de connexion envoyé par Uber. */
  jetonGmail?: () => Promise<string | null>;
  /** Demande le code au gérant dans l'app et attend sa saisie (null si rien dans le délai). */
  attendreCode?: (canal: "sms" | "mail" | "inconnu") => Promise<string | null>;
}

/** Premier code obtenu : lu dans la boîte Gmail du restaurant, ou tapé par le gérant dans l'app. */
async function obtenirCode(cfg: ConfigUber, canal: "sms" | "mail" | "inconnu", depuis: number): Promise<string | null> {
  const sources: Promise<string | null>[] = [];
  if (cfg.attendreCode) sources.push(cfg.attendreCode(canal));
  if (canal !== "sms" && cfg.jetonGmail) {
    sources.push(
      cfg
        .jetonGmail()
        .then((j) => (j ? codeParMail(j, depuis) : null))
        .catch(() => null),
    );
  }
  if (!sources.length) return null;
  // Le premier code trouvé gagne ; null seulement si toutes les sources échouent.
  return new Promise((resolve) => {
    let restantes = sources.length;
    for (const p of sources) {
      p.then((c) => {
        if (c) resolve(c);
        else if (--restantes === 0) resolve(null);
      });
    }
  });
}

export interface SessionUber {
  page: Page;
  appels: string[];
  fermer: () => Promise<string>; // renvoie les cookies à garder
}

async function capture(page: Page): Promise<string | undefined> {
  try {
    const img = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    return Buffer.from(img).toString("base64");
  } catch {
    return undefined;
  }
}

async function diag(page: Page, etape: string, appels: string[]): Promise<DiagnosticUber> {
  return { ...(await diagnostic(page, etape, appels)), capture: await capture(page) };
}

const texte = (page: Page) => page.evaluate(() => document.body?.innerText ?? "").catch(() => "");

/** Premier élément visible qui correspond (les étapes cachées d'un formulaire réutilisent souvent les mêmes boutons). */
async function visible(page: Page, selecteur: string) {
  for (const el of await page.$$(selecteur)) if (await el.isVisible().catch(() => false)) return el;
  return null;
}

const SEL_EMAIL = ["#PHONE_NUMBER_or_EMAIL_ADDRESS", "input[type=email]", "input[name=email]", "input[autocomplete=username]", "input[name*=email i]"].join(", ");
const SEL_MDP = ["#PASSWORD", "input[type=password]"].join(", ");
const SEL_CODE = ["input[autocomplete=one-time-code]", "input[id*=OTP]", "input[name*=otp i]", "input[id*=code i]", "input[name*=code i]"].join(", ");

async function valider(page: Page) {
  const bouton = await visible(page, "#forward-button, button[type=submit]");
  if (bouton) await bouton.click();
  else if (!(await cliquerTexte(page, "^(continuer|suivant|valider|se connecter|next|continue|submit)$"))) await page.keyboard.press("Enter");
  await Promise.race([page.waitForNavigation({ timeout: 12_000 }).catch(() => {}), pause(4_000)]);
  await calme(page);
}

/** Cherche dans la boîte Gmail du restaurant le code envoyé par Uber depuis `depuis` (ms). */
async function codeParMail(jeton: string, depuis: number): Promise<string | null> {
  const fin = Date.now() + 60_000;
  while (Date.now() < fin) {
    const ids = await listMessageIds(jeton, "from:(uber.com) newer_than:1d", 5).catch(() => []);
    for (const id of ids) {
      const m = await getMessage(jeton, id).catch(() => null);
      if (!m || Number(m.internalDate ?? 0) < depuis - 30_000) continue;
      const code = codeUberDepuisMail(header(m, "Subject"), bodyText(m));
      if (code) return code;
    }
    await pause(5_000);
  }
  return null;
}

async function taperCode(page: Page, code: string) {
  const champs = [];
  for (const el of await page.$$(SEL_CODE + ", input[inputmode=numeric]")) if (await el.isVisible().catch(() => false)) champs.push(el);
  if (champs.length > 1) {
    // Une case par chiffre.
    for (let i = 0; i < Math.min(champs.length, code.length); i++) await champs[i].type(code[i], { delay: 40 });
  } else if (champs[0]) {
    await champs[0].type(code, { delay: 40 });
  }
}

const surManager = (page: Page) => {
  try {
    const u = new URL(page.url());
    return u.host === new URL(UBER_MANAGER_URL).host && !/login|auth/i.test(u.pathname);
  } catch {
    return false;
  }
};

/** Ouvre Uber Eats Manager, connecté. Reprend la session gardée si elle est encore valable. */
export async function ouvrirUber(cfg: ConfigUber): Promise<SessionUber> {
  const browser = await lancer();
  const appels: string[] = [];
  const fermer = async () => {
    const c = await browser.cookies().catch(() => []);
    await browser.close().catch(() => {});
    return JSON.stringify(c.filter((x) => /uber(eats)?\.com$/.test(x.domain.replace(/^\./, ""))));
  };
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(20_000);
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    );
    await page.setExtraHTTPHeaders({ "accept-language": "fr-FR,fr;q=0.9" });
    page.on("response", (r) => {
      const t = r.request().resourceType();
      if (t === "xhr" || t === "fetch") appels.push(`${r.request().method()} ${r.status()} ${urlSansSecret(r.url())}`);
    });
    if (cfg.cookies) {
      try {
        await browser.setCookie(...JSON.parse(cfg.cookies));
      } catch {
        /* cookies illisibles : connexion complète */
      }
    }
    await page.goto(UBER_MANAGER_URL, { waitUntil: "networkidle2", timeout: 40_000 }).catch(() => {});
    await calme(page);

    const debut = Date.now();
    for (let etape = 0; etape < 8 && !surManager(page); etape++) {
      const t = await texte(page);
      if (antiRobot(t)) throw new UberError("Uber demande une vérification anti-robot : connexion automatique impossible pour l'instant.", await diag(page, "connexion", appels), "anti_robot");

      const mdp = await visible(page, SEL_MDP);
      if (mdp) {
        await mdp.click({ count: 3 });
        await mdp.type(cfg.motDePasse, { delay: 25 });
        await valider(page);
        const encore = await visible(page, SEL_MDP);
        if (encore && /incorrect|invalide|wrong|erreur/i.test(await texte(page))) {
          throw new UberError("Uber refuse le mot de passe : vérifie-le dans Réglages.", await diag(page, "mot de passe", appels), "identifiants");
        }
        continue;
      }

      const code = demandeCode(t) && (await visible(page, SEL_CODE + ", input[inputmode=numeric]"));
      if (code) {
        // On préfère le mot de passe quand Uber propose « Plus d'options ».
        if (etape < 3 && (await cliquerTexte(page, "^(plus d.options|more options|autres options)$"))) {
          await pause(1_000);
          if (await cliquerTexte(page, "^(mot de passe|password)$")) {
            await calme(page);
            continue;
          }
        }
        const canal = demandeCode(t) ?? "inconnu";
        const lu = await obtenirCode(cfg, canal, debut);
        if (!lu) {
          throw new UberError(
            cfg.attendreCode
              ? "Uber a demandé un code de vérification et il n'a pas été saisi à temps (2 minutes). Relance et tape le code dès qu'il arrive."
              : "Uber demande un code de vérification : lance le robot depuis l'app (« Relever maintenant ») pour pouvoir le saisir.",
            await diag(page, "code", appels),
            canal === "sms" ? "code_sms" : "code_mail",
          );
        }
        await taperCode(page, lu);
        await valider(page);
        continue;
      }

      const email = await visible(page, SEL_EMAIL);
      if (email) {
        await email.click({ count: 3 });
        await email.type(cfg.email, { delay: 25 });
        await valider(page);
        continue;
      }

      // Bouton « Se connecter » sur une page d'accueil.
      if (!(await cliquerTexte(page, "^(se connecter|connexion|sign in|log in)$"))) await pause(2_000);
      await calme(page);
    }
    if (!surManager(page)) throw new UberError("Connexion à Uber Eats Manager non aboutie.", await diag(page, "connexion", appels), "page_inconnue");
    return { page, appels, fermer };
  } catch (e) {
    await browser.close().catch(() => {});
    if (e instanceof UberError) throw e;
    throw new UberError(`Robot Uber Eats : ${(e as Error).message}`);
  }
}

/** Va sur la liste des commandes avec un problème (adresse donnée dans Réglages, sinon par les menus). */
async function allerAuxProblemes(s: SessionUber, cfg: ConfigUber) {
  const { page, appels } = s;
  if (cfg.urlProblemes) {
    await page.goto(cfg.urlProblemes, { waitUntil: "networkidle2", timeout: 40_000 }).catch(() => {});
  } else {
    await cliquerTexte(page, "^commandes$");
    await calme(page);
    await cliquerTexte(page, "^(probl[eè]mes?|erreurs?( de commande)?|commandes avec (un )?probl[eè]me)$");
  }
  await calme(page);
  await page.waitForFunction(() => /identifiant de la commande|probl[eè]me/i.test(document.body.innerText), { timeout: 20_000 }).catch(() => {});
  if (!/identifiant de la commande/i.test(await texte(page))) {
    throw new UberError(
      "Liste des problèmes introuvable : colle dans Réglages l'adresse de la page Uber Eats Manager qui affiche le tableau des problèmes.",
      await diag(page, "liste", appels),
      "page_inconnue",
    );
  }
}

/** Lignes du tableau : une entrée par commande, cellules séparées par des tabulations (une cellule peut tenir sur plusieurs lignes). */
async function lignesTableau(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const lignes = [...document.querySelectorAll<HTMLElement>("table tbody tr, [role=row]")];
    if (!lignes.length) return [document.body.innerText];
    return lignes.map((tr) => {
      const cellules = [...tr.querySelectorAll<HTMLElement>("td, [role=cell], [role=gridcell]")];
      return (cellules.length ? cellules.map((c) => c.innerText.replace(/\s*\n\s*/g, "\n")) : [tr.innerText]).join("\t");
    });
  });
}

/** Lit les commandes avec un problème (de la boutique du restaurant si elle est précisée). */
export async function lireProblemes(s: SessionUber, cfg: ConfigUber): Promise<{ lignes: LigneUber[]; diagnostic: DiagnosticUber }> {
  await allerAuxProblemes(s, cfg);
  const lignes = (await lignesTableau(s.page)).filter((l) => ligneDeLaBoutique(l, cfg.boutique ?? ""));
  return { lignes: lireCopieUber(lignes.join("\n")), diagnostic: await diag(s.page, "liste", s.appels) };
}

async function ouvrirCommande(s: SessionUber, cfg: ConfigUber, commande: string) {
  await allerAuxProblemes(s, cfg);
  const id = commande.replace(/[^0-9A-Za-z]/g, "");
  if (!(await cliquerTexte(s.page, `^${id}$`))) {
    throw new UberError(`Commande ${id} absente de la liste des problèmes (trop ancienne ?).`, await diag(s.page, "commande", s.appels), "page_inconnue");
  }
  await calme(s.page);
  await pause(1_000);
}

/** Ouvre une commande et lit le montant retenu au restaurant. */
export async function lireMontant(s: SessionUber, cfg: ConfigUber, commande: string): Promise<number | null> {
  await ouvrirCommande(s, cfg, commande);
  return montantRetenu(await texte(s.page));
}

export interface ResultatContestation {
  envoyee: boolean;
  montant: number | null;
  diagnostic: DiagnosticUber;
}

/**
 * Conteste une commande : bouton « Contester », message, envoi, puis vérifie la confirmation.
 * essai = true : remplit le formulaire mais n'envoie pas (pour vérifier sur la capture).
 */
export async function contester(s: SessionUber, cfg: ConfigUber, commande: string, message: string, essai: boolean): Promise<ResultatContestation> {
  const { page, appels } = s;
  await ouvrirCommande(s, cfg, commande);
  const montant = montantRetenu(await texte(page));
  if (!(await cliquerTexte(page, "^(contester( l.(erreur|ajustement))?( le probl[eè]me)?|faire (une )?contestation|faire appel|dispute|signaler un d[ée]saccord)$"))) {
    throw new UberError("Bouton « Contester » introuvable sur la commande.", await diag(page, "contester", appels), "page_inconnue");
  }
  await calme(page);
  await pause(1_000);

  // Certaines fenêtres demandent un motif avant le champ texte : on prend le premier choix proposé.
  if (!(await visible(page, "textarea"))) {
    const radio = await visible(page, "input[type=radio], [role=radio]");
    if (radio) {
      await radio.click();
      await cliquerTexte(page, "^(suivant|continuer|next)$");
      await calme(page);
    }
  }
  const zone = await visible(page, "textarea");
  if (!zone) throw new UberError("Champ du message de contestation introuvable.", await diag(page, "message", appels), "page_inconnue");
  await zone.click();
  await zone.type(message, { delay: 5 });

  if (essai) return { envoyee: false, montant, diagnostic: await diag(page, "essai (non envoyé)", appels) };

  if (!(await cliquerTexte(page, "^(envoyer|soumettre|valider|contester|envoyer la contestation|submit|send)$"))) {
    throw new UberError("Bouton d'envoi de la contestation introuvable.", await diag(page, "envoi", appels), "page_inconnue");
  }
  await calme(page);
  await pause(1_500);
  const t = await texte(page);
  const envoyee = contestationConfirmee(t) || !(await visible(page, "textarea"));
  return { envoyee, montant, diagnostic: await diag(page, envoyee ? "envoyée" : "envoi non confirmé", appels) };
}
