/**
 * Lecture des messages Gmail (format « full » de l'API Gmail) : en-têtes, pièces jointes PDF,
 * texte du corps, et tri entre factures fournisseurs, relevés Uber Eats et le reste.
 * Fichier sans dépendance serveur pour pouvoir être testé.
 */

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string; // millisecondes, en texte
  snippet?: string;
  payload?: GmailPart;
}

/**
 * Règles de tri, modifiables dans settings/mail (champ « regles ») sans redéployer.
 * Valeurs par défaut tirées de l'audit de la boîte du 31/10/2026 (mail/audit-boite-mail.md).
 */
export interface MailRules {
  /** Adresses ou domaines qui envoient les récaps de versement Uber Eats. */
  uberExpediteurs: string[];
  /** Expressions de l'objet qui désignent un récap de versement (les courses [Business] viennent du même expéditeur). */
  uberMotsCles: string[];
  /** Mots qui, dans l'objet ou le nom du PDF, signalent une facture d'un expéditeur inconnu. */
  factureMotsCles: string[];
  /** Mots de l'objet qui écartent un mail de fournisseur (relances, relevés de compte…). */
  factureExclure: string[];
  /** Expéditeurs (adresse ou domaine) ou expressions de l'objet à ignorer. */
  ignorer: string[];
  /** Fournisseurs connus : adresse ou domaine d'expéditeur → nom du fournisseur. */
  fournisseurs: Record<string, string>;
}

export const DEFAULT_RULES: MailRules = {
  uberExpediteurs: ["noreply@uber.com", "restaurantsfrance@uber.com"],
  uberMotsCles: ["récapitulatif des versements", "récapitulatif de paiement"],
  factureMotsCles: ["facture", "factures", "invoice", "avoir", "fac"],
  factureExclure: ["relance", "relevé", "factures manquantes", "bon de livraison"],
  ignorer: ["[business]", "ads.uber.com", "feedback.uber.com", "francetravail.fr", "marketing@laddition.com", "annonce@amazon.fr", "jds-associes.com", "newsletter"],
  fournisseurs: {
    "hpsrungis.com": "Halles Paris Sud",
    "makabi.fr": "SAS Cash Service",
    "yardenfrance.com": "Yarden France",
    "labeldelice.fr": "Label Délice",
    "e-facture.net": "Délice et Création",
    "deliceetcreation.fr": "Délice et Création",
    "smel-distrib@invoicing.pennylane.com": "SMEL Distrib",
    "ims-cash@invoicing.pennylane.com": "IMS Cash",
    "as-gourmet.fr": "A.S. Gourmet",
    "fjordking.com": "Fjord King",
    "mympery@free.fr": "MYM Distribution",
    "ravimoshark.com": "Ravimo",
    "olivscooter@gmail.com": "Oliv'Scooter",
    "selection-bokobsa.com": "Sélection Bokobsa",
    "metro-marketplace.eu": "Metro",
    "locam.fr": "Locam",
    "swile.co": "Swile",
    "edf.fr": "EDF",
    "enedis.fr": "Enedis",
    "upvise.com": "Upvise (nuisibles)",
  },
};

export function mergeRules(stored: Partial<MailRules> | undefined): MailRules {
  const list = (v: unknown, d: string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase()) : d;
  const map = (v: unknown, d: Record<string, string>) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, n]) => typeof n === "string" && n.trim())
            .map(([k, n]) => [k.trim().toLowerCase(), String(n).trim()]),
        )
      : d;
  return {
    uberExpediteurs: list(stored?.uberExpediteurs, DEFAULT_RULES.uberExpediteurs),
    uberMotsCles: list(stored?.uberMotsCles, DEFAULT_RULES.uberMotsCles),
    factureMotsCles: list(stored?.factureMotsCles, DEFAULT_RULES.factureMotsCles),
    factureExclure: list(stored?.factureExclure, DEFAULT_RULES.factureExclure),
    ignorer: list(stored?.ignorer, DEFAULT_RULES.ignorer),
    fournisseurs: map(stored?.fournisseurs, DEFAULT_RULES.fournisseurs),
  };
}

export function header(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

/** "Metro France <factures@metro.fr>" → "factures@metro.fr" */
export function emailOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

/** "Metro France <factures@metro.fr>" → "Metro France" (ou le domaine si pas de nom). */
export function displayNameOf(from: string): string {
  const m = from.match(/^\s*"?([^"<]+?)"?\s*</);
  if (m && m[1].trim()) return m[1].trim();
  const domain = emailOf(from).split("@")[1] ?? "";
  return domain.split(".").slice(-2, -1)[0] ?? domain;
}

/** Vrai si l'adresse correspond à une règle (adresse exacte ou domaine, sous-domaines compris). */
export function senderMatches(email: string, rules: string[]): boolean {
  const domain = email.split("@")[1] ?? "";
  return rules.some((r) => {
    const rule = r.replace(/^@/, "");
    return rule.includes("@") ? email === rule : domain === rule || domain.endsWith(`.${rule}`);
  });
}

/** Nom du fournisseur connu pour cet expéditeur (règle la plus précise : adresse exacte, puis domaine le plus long). */
export function knownSupplier(email: string, fournisseurs: Record<string, string>): string | null {
  const keys = Object.keys(fournisseurs).filter((k) => senderMatches(email, [k]));
  if (!keys.length) return null;
  keys.sort((a, b) => Number(b.includes("@")) - Number(a.includes("@")) || b.length - a.length);
  return fournisseurs[keys[0]];
}

export function decodeBase64Url(data: string): Buffer {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function* walk(part: GmailPart | undefined): Generator<GmailPart> {
  if (!part) return;
  yield part;
  for (const p of part.parts ?? []) yield* walk(p);
}

export interface PdfRef {
  filename: string;
  attachmentId?: string;
  data?: string; // base64url, quand la pièce est petite et incluse
  size: number;
}

export function pdfAttachments(msg: GmailMessage): PdfRef[] {
  const out: PdfRef[] = [];
  for (const p of walk(msg.payload)) {
    // On se fie à l'extension : certains fournisseurs envoient leurs PDF en application/octet-stream.
    const name = p.filename ?? "";
    const isPdf = /\.pdf$/i.test(name) || (p.mimeType === "application/pdf" && !name);
    if (!isPdf || (!p.body?.attachmentId && !p.body?.data)) continue;
    out.push({ filename: name || "document.pdf", attachmentId: p.body.attachmentId, data: p.body.data, size: p.body.size ?? 0 });
  }
  return out;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&euro;/g, "€")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** Texte du mail : partie text/plain si elle existe, sinon HTML converti. Limité à 20 000 caractères. */
export function bodyText(msg: GmailMessage): string {
  let plain = "";
  let html = "";
  for (const p of walk(msg.payload)) {
    if (p.filename || !p.body?.data) continue;
    if (p.mimeType === "text/plain" && !plain) plain = decodeBase64Url(p.body.data).toString("utf8");
    if (p.mimeType === "text/html" && !html) html = decodeBase64Url(p.body.data).toString("utf8");
  }
  return (plain.trim() || htmlToText(html) || msg.snippet || "").slice(0, 20000);
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Un mot-clé d'un seul mot doit apparaître comme mot entier ; une expression, comme sous-chaîne (sans accents ni casse). */
function hasKeyword(text: string, keywords: string[]): boolean {
  const w = new Set(words(text));
  const t = fold(text);
  return keywords.some((k) => (/[^a-z0-9]/i.test(fold(k).trim()) ? t.includes(fold(k).trim()) : w.has(fold(k))));
}

function ignored(from: string, subject: string, rules: MailRules): boolean {
  return rules.ignorer.some((r) => (/^[^\s]*[@.][^\s]*$/.test(r) && !r.startsWith("[") ? senderMatches(from, [r]) : fold(subject).includes(fold(r))));
}

export type MailKind = "uber" | "facture";

/**
 * Tri d'un message :
 * - « uber » : récap de versement Uber Eats (expéditeur ET objet, pour écarter les courses [Business]) ;
 * - « facture » : fournisseur connu (PDF, ou montant lisible dans le mail), ou PDF + mot-clé facture ;
 * - null : on ignore.
 */
export function classify(msg: GmailMessage, rules: MailRules, supplierEmails: string[]): MailKind | null {
  const from = emailOf(header(msg, "From"));
  const subject = header(msg, "Subject");
  if (ignored(from, subject, rules)) return null;

  if (senderMatches(from, rules.uberExpediteurs) || senderMatches(from, ["uber.com"])) {
    return hasKeyword(subject, rules.uberMotsCles) ? "uber" : null;
  }
  const pdfs = pdfAttachments(msg);
  const known = knownSupplier(from, rules.fournisseurs) !== null || senderMatches(from, supplierEmails.map((e) => e.toLowerCase()));
  if (known) {
    if (hasKeyword(subject, rules.factureExclure)) return null;
    if (pdfs.length) return "facture";
    const t = parseFactureText(subject, bodyText(msg));
    return t.montantTTC !== undefined ? "facture" : null;
  }
  if (pdfs.length === 0) return null;
  if (hasKeyword(subject, rules.factureExclure)) return null;
  if (hasKeyword(subject, rules.factureMotsCles)) return "facture";
  if (pdfs.some((p) => hasKeyword(p.filename, rules.factureMotsCles))) return "facture";
  return null;
}

/** Requête Gmail : mails récents avec PDF, des fournisseurs connus ou d'Uber (hors envoyés, spam, promotions). */
export function gmailQuery(days: number, rules: MailRules): string {
  const senders = [...rules.uberExpediteurs, ...Object.keys(rules.fournisseurs)];
  const from = senders.length ? ` OR from:(${senders.join(" OR ")})` : "";
  return `newer_than:${days}d -in:sent -in:spam -in:trash -from:me -category:promotions (has:attachment filename:pdf${from})`;
}

// ---------------------------------------------------------------------------
// Lecture sans IA : montants écrits dans l'objet ou le corps du mail.

/** "4 781,33" / "1.234,56" / "419.02" → centimes. */
export function frenchCents(s: string): number | undefined {
  let t = s.replace(/[\s\u00a0\u202f€]/g, "").replace(/^\+/, "");
  if (!t) return undefined;
  if (t.includes(",") && t.includes(".")) t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  else t = t.replace(",", ".");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return undefined;
  return Math.round(parseFloat(t) * 100);
}

const dmy = (d: string, m: string, y: string) => `${y.length === 2 ? `20${y}` : y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
const NUM = "(-?\\d{1,3}(?:[\\s\\u00a0\\u202f.]\\d{3})*(?:[.,]\\d{1,2})?|-?\\d+(?:[.,]\\d{1,2})?)";

export interface TextFacture {
  numero?: string;
  dateFacture?: string;
  dateEcheance?: string;
  montantTTC?: number;
}

/**
 * Ce que l'objet et le corps disent d'une facture (formats vus dans la boîte) :
 * Pennylane « d'un montant de 132,19 € … avant le 23/10/2026 », e-facture « Montant TTC de la facture : 419.02 EUR »,
 * A.S. Gourmet « Facture - FAC53820 - 304,22 € TTC », HPS « FAC-20261027-123456 », Makabi / Yarden « en date du 27102026 ».
 */
export function parseFactureText(subject: string, body: string): TextFacture {
  const out: TextFacture = {};
  const all = `${subject}\n${body}`;
  let m: RegExpMatchArray | null;

  if ((m = all.match(new RegExp(`Montant TTC de la facture\\s*:\\s*${NUM}\\s*(?:EUR|€)`, "i")))) out.montantTTC = frenchCents(m[1]);
  else if ((m = subject.match(new RegExp(`-\\s*${NUM}\\s*€\\s*TTC`, "i")))) out.montantTTC = frenchCents(m[1]);
  else if ((m = all.match(new RegExp(`montant (?:total )?de\\s*${NUM}\\s*€`, "i")))) out.montantTTC = frenchCents(m[1]);

  if ((m = all.match(/Date de la facture\s*:\s*(\d{4})-(\d{2})-(\d{2})/i))) out.dateFacture = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = all.match(/en date du\s*(\d{2})(\d{2})(\d{4})\b/i))) out.dateFacture = dmy(m[1], m[2], m[3]);
  else if ((m = all.match(/en date du\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i))) out.dateFacture = dmy(m[1], m[2], m[3]);

  if ((m = all.match(/avant le\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i))) out.dateEcheance = dmy(m[1], m[2], m[3]);

  if ((m = all.match(/\bFAC-(\d{4})(\d{2})(\d{2})-\d+\b/))) {
    out.numero = m[0];
    out.dateFacture ??= `${m[1]}-${m[2]}-${m[3]}`;
  } else if ((m = subject.match(/\b(FAC\d{3,}|F[AP]\d{4,}|F-\d{4}-\d{2}-\d+|F\d{8}-\d+)\b/i))) out.numero = m[1];
  else if ((m = body.match(/\b(F-\d{4}-\d{2}-\d+|F\d{8}-\d+)\b/))) out.numero = m[1];
  else if ((m = all.match(/(?:facture|invoice)\s*(?:n[°o]\.?|num[ée]ro|#)\s*:?\s*([A-Z0-9][A-Z0-9_\/-]{2,})/i))) out.numero = m[1];
  return out;
}

export interface TextUber {
  periode?: string;
  debut?: string;
  fin?: string;
  versementBancaire?: number;
  titresRestaurant?: number;
  versementNet?: number;
  fraisUber?: number;
  revenusTotaux?: number;
}

const MONTHS: Record<string, string> = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/**
 * Récap hebdomadaire Uber Eats. Période dans l'objet :
 * « … Oct 19, 2026 - Oct 25, 2026 » (depuis août 2026) ou « … du 7/20/26 au 7/26/26 » (avant, mois/jour/an).
 * Montants dans le corps : « Versement bancaire 4 781,33 € », « Titres-restaurant », « Versement net », « Total des frais Uber », « Revenus totaux ».
 */
export function parseUberRecap(subject: string, body: string): TextUber {
  const out: TextUber = {};
  let m = subject.match(/([A-Za-z]{3})\w*\.? (\d{1,2}), (\d{4})\s*[-–]\s*([A-Za-z]{3})\w*\.? (\d{1,2}), (\d{4})/);
  if (m && MONTHS[m[1].toLowerCase()] && MONTHS[m[4].toLowerCase()]) {
    out.debut = `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, "0")}`;
    out.fin = `${m[6]}-${MONTHS[m[4].toLowerCase()]}-${m[5].padStart(2, "0")}`;
  } else if ((m = subject.match(/du (\d{1,2})\/(\d{1,2})\/(\d{2,4}) au (\d{1,2})\/(\d{1,2})\/(\d{2,4})/))) {
    out.debut = dmy(m[2], m[1], m[3]);
    out.fin = dmy(m[5], m[4], m[6]);
  }
  if (out.debut && out.fin) out.periode = `${out.debut.split("-").reverse().join("/")} au ${out.fin.split("-").reverse().join("/")}`;

  const amount = (label: string) => {
    const r = body.match(new RegExp(`${label}[\\s|:]*${NUM}\\s*€`, "i"));
    return r ? frenchCents(r[1]) : undefined;
  };
  out.versementBancaire = amount("Versement bancaire");
  out.titresRestaurant = amount("Titres[- ]restaurant");
  out.versementNet = amount("Versement net");
  out.fraisUber = amount("Total des frais Uber");
  out.revenusTotaux = amount("Revenus totaux");
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as TextUber;
}

// ---------------------------------------------------------------------------
// Établissement : la boîte reçoit les pièces du 19e (SAS AVA, rue Manin) et du 17e (rue de Prony).

export type Etablissement = "19e" | "17e";

export function detectEtablissement(text: string): Etablissement | undefined {
  const t = fold(text);
  const p17 = /prony|75017|letibsprony17|tib'?s 17|tibs 17/.test(t);
  const p19 = /manin|75019|834278095|sas ava\b|tib'?s 19|tibs 19/.test(t);
  if (p17 && !p19) return "17e";
  if (p19 && !p17) return "19e";
  return undefined;
}

/** Tout ce qui peut indiquer l'établissement : destinataires, objet, corps, noms des PDF. */
export function etablissementOf(msg: GmailMessage): Etablissement | undefined {
  const text = [header(msg, "To"), header(msg, "Cc"), header(msg, "Subject"), bodyText(msg), ...pdfAttachments(msg).map((p) => p.filename)].join("\n");
  return detectEtablissement(text);
}
