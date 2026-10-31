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

/** Règles de tri, modifiables dans settings/mail (champ « regles ») sans redéployer. */
export interface MailRules {
  /** Domaines ou adresses d'expéditeur des relevés Uber Eats. */
  uberExpediteurs: string[];
  /** Mots qui, dans l'objet, signalent un relevé de paiement Uber (et pas un reçu de course). */
  uberMotsCles: string[];
  /** Mots qui, dans l'objet ou le nom du PDF, signalent une facture. */
  factureMotsCles: string[];
  /** Expéditeurs à ignorer (banque, publicité…). */
  ignorer: string[];
}

export const DEFAULT_RULES: MailRules = {
  uberExpediteurs: ["uber.com", "ubereats.com"],
  uberMotsCles: ["paiement", "versement", "virement", "relevé", "releve", "payment", "payout", "statement", "facture", "invoice"],
  factureMotsCles: ["facture", "factures", "invoice", "avoir", "fact", "fac"],
  ignorer: [],
};

export function mergeRules(stored: Partial<MailRules> | undefined): MailRules {
  const list = (v: unknown, d: string[]) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase()) : d;
  return {
    uberExpediteurs: list(stored?.uberExpediteurs, DEFAULT_RULES.uberExpediteurs),
    uberMotsCles: list(stored?.uberMotsCles, DEFAULT_RULES.uberMotsCles),
    factureMotsCles: list(stored?.factureMotsCles, DEFAULT_RULES.factureMotsCles),
    ignorer: list(stored?.ignorer, DEFAULT_RULES.ignorer),
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
    const name = p.filename ?? "";
    const isPdf = p.mimeType === "application/pdf" || /\.pdf$/i.test(name);
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

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

function hasKeyword(text: string, keywords: string[]): boolean {
  const w = new Set(words(text));
  return keywords.some((k) => words(k).every((x) => w.has(x)));
}

export type MailKind = "uber" | "facture";

/**
 * Tri d'un message :
 * - « uber » : expéditeur Uber et objet qui parle de paiement / relevé ;
 * - « facture » : au moins un PDF, et un expéditeur fournisseur connu ou un mot-clé facture dans l'objet ou le nom du PDF ;
 * - null : on ignore.
 */
export function classify(msg: GmailMessage, rules: MailRules, supplierEmails: string[]): MailKind | null {
  const from = emailOf(header(msg, "From"));
  const subject = header(msg, "Subject");
  if (senderMatches(from, rules.ignorer)) return null;
  const pdfs = pdfAttachments(msg);

  if (senderMatches(from, rules.uberExpediteurs)) {
    return hasKeyword(subject, rules.uberMotsCles) ? "uber" : null;
  }
  if (pdfs.length === 0) return null;
  if (senderMatches(from, supplierEmails.map((e) => e.toLowerCase()))) return "facture";
  if (hasKeyword(subject, rules.factureMotsCles)) return "facture";
  if (pdfs.some((p) => hasKeyword(p.filename, rules.factureMotsCles))) return "facture";
  return null;
}

/** Requête Gmail : mails récents avec PDF, ou venant d'Uber. */
export function gmailQuery(days: number, rules: MailRules): string {
  const uber = rules.uberExpediteurs.map((d) => `from:${d}`).join(" OR ");
  return `newer_than:${days}d -in:spam -in:trash (has:attachment filename:pdf${uber ? ` OR ${uber}` : ""})`;
}
