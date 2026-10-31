import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { toIsoDate } from "@/lib/money";

/**
 * Lecture des PDF et des mails par l'API Claude (facultatif) : sans ANTHROPIC_API_KEY,
 * les éléments arrivent « à compléter » et le gérant saisit les montants en validant.
 */
export const extractionEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const MODEL = "claude-opus-5-5";

const FactureSchema = z.object({
  est_facture: z.boolean().describe("true si le document est une facture ou un avoir adressé au restaurant"),
  avoir: z.boolean().describe("true si c'est un avoir (note de crédit)"),
  fournisseur: z.string().describe("raison sociale du fournisseur qui émet la facture"),
  numero: z.string().describe("numéro de facture, chaîne vide si absent"),
  date_facture: z.string().describe("date de la facture au format AAAA-MM-JJ, chaîne vide si absente"),
  date_echeance: z.string().describe("date d'échéance AAAA-MM-JJ, chaîne vide si absente"),
  montant_ht: z.number().nullable().describe("total hors taxes en euros"),
  montant_tva: z.number().nullable().describe("total de TVA en euros"),
  montant_ttc: z.number().nullable().describe("total TTC / net à payer en euros"),
});

const UberSchema = z.object({
  est_versement: z.boolean().describe("true si le message annonce un paiement / virement d'Uber Eats au restaurant"),
  date_versement: z.string().describe("date du virement AAAA-MM-JJ (ou fin de période si seule celle-ci figure), chaîne vide si absente"),
  montant_net: z.number().nullable().describe("montant net versé au restaurant, en euros"),
  ventes_brutes: z.number().nullable().describe("ventes TTC de la période en euros, si indiquées"),
  frais: z.number().nullable().describe("commission et frais Uber en euros (valeur positive), si indiqués"),
  reference: z.string().describe("référence du paiement ou période (ex. 07/10–13/10), chaîne vide si absente"),
});

export interface ExtractedFacture {
  fournisseur?: string;
  numero?: string;
  dateFacture?: string;
  dateEcheance?: string;
  montantHT?: number;
  montantTVA?: number;
  montantTTC?: number;
}

export interface ExtractedUber {
  date?: string;
  montant?: number;
  brut?: number;
  frais?: number;
  reference?: string;
}

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic());

const cents = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : undefined);
const iso = (s: string) => toIsoDate(s) ?? undefined;
const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;

const SYSTEM =
  "Tu lis les documents reçus par mail par un restaurant français (Le Tib's) pour sa comptabilité. " +
  "Recopie les valeurs telles qu'elles figurent sur le document, sans rien inventer : laisse vide (ou null) ce qui n'y est pas. " +
  "Montants en euros avec le point comme séparateur décimal.";

async function ask<S extends z.ZodType>(schema: S, content: Anthropic.Beta.BetaContentBlockParam[]): Promise<z.infer<S> | null> {
  const res = await anthropic().beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: SYSTEM,
    output_config: { effort: "low", format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return null;
  return (res.parsed_output as z.infer<S> | null) ?? null;
}

const contextLine = (c: { from: string; subject: string; filename?: string }) =>
  `Mail de : ${c.from}\nObjet : ${c.subject}${c.filename ? `\nPièce jointe : ${c.filename}` : ""}`;

/** null si le PDF n'est pas une facture. Les montants d'un avoir sont rendus négatifs. */
export async function extractFacture(
  pdfBase64: string,
  ctx: { from: string; subject: string; filename: string },
): Promise<ExtractedFacture | null> {
  const r = await ask(FactureSchema, [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: `${contextLine(ctx)}\n\nCe document est-il une facture fournisseur ? Si oui, relève ses informations.` },
  ]);
  if (!r || !r.est_facture) return null;
  const sign = r.avoir ? -1 : 1;
  const signed = (v: number | null) => {
    const c = cents(v === null ? null : Math.abs(v));
    return c === undefined ? undefined : sign * c;
  };
  return clean({
    fournisseur: r.fournisseur.trim(),
    numero: r.numero.trim(),
    dateFacture: iso(r.date_facture),
    dateEcheance: iso(r.date_echeance),
    montantHT: signed(r.montant_ht),
    montantTVA: signed(r.montant_tva),
    montantTTC: signed(r.montant_ttc),
  });
}

/** null si le mail n'annonce pas de versement. */
export async function extractUber(
  text: string,
  pdfBase64: string | undefined,
  ctx: { from: string; subject: string; receivedAt: string },
): Promise<ExtractedUber | null> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (pdfBase64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } });
  content.push({
    type: "text",
    text: `${contextLine(ctx)}\nReçu le : ${ctx.receivedAt}\n\nCorps du mail :\n${text}\n\nCe message annonce-t-il un versement d'Uber Eats au restaurant ? Si oui, relève-le.`,
  });
  const r = await ask(UberSchema, content);
  if (!r || !r.est_versement) return null;
  return clean({
    date: iso(r.date_versement),
    montant: cents(r.montant_net),
    brut: cents(r.ventes_brutes),
    frais: cents(r.frais === null ? null : Math.abs(r.frais)),
    reference: r.reference.trim(),
  });
}
