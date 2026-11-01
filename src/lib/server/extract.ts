import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { toIsoDate } from "@/lib/money";
import { coutUsd, MODELES, type Reglages } from "@/lib/reglages";

/**
 * Lecture des PDF et des mails par l'API Claude (facultatif) : sans ANTHROPIC_API_KEY,
 * les éléments arrivent « à compléter » et le gérant saisit les montants en validant.
 */
export const extractionEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

/**
 * Compteur d'une vérification : applique les limites des Réglages (lecture activée, nombre max
 * de PDF, budget du mois) et additionne la dépense réelle renvoyée par l'API.
 */
export class Lecteur {
  lectures = 0;
  entree = 0;
  sortie = 0;
  cout = 0;
  /** Pourquoi une lecture a été refusée (affiché au gérant). */
  limite: "max" | "budget" | null = null;

  constructor(
    readonly reglages: Reglages,
    private readonly depenseMoisUsd = 0,
  ) {}

  /** Raison à noter sur un élément non lu. */
  get raison(): "limite" | "budget" | "desactivee" {
    if (!this.actif) return "desactivee";
    return this.limite === "budget" ? "budget" : "limite";
  }

  get actif() {
    return extractionEnabled() && this.reglages.lecturePdf;
  }

  peutLire(): boolean {
    if (!this.actif) return false;
    if (this.lectures >= this.reglages.maxLecturesParVerification) {
      this.limite ??= "max";
      return false;
    }
    if (this.reglages.budgetMensuelUsd > 0 && this.depenseMoisUsd + this.cout >= this.reglages.budgetMensuelUsd) {
      this.limite ??= "budget";
      return false;
    }
    return true;
  }

  compter(u: { input_tokens?: number | null; output_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) {
    const entree = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    const sortie = u.output_tokens ?? 0;
    this.lectures++;
    this.entree += entree;
    this.sortie += sortie;
    this.cout += coutUsd(this.reglages.modele, entree, sortie);
  }
}

const FactureSchema = z.object({
  type_document: z
    .enum(["facture", "avoir", "releve", "autre"])
    .describe(
      "facture ou avoir : une seule pièce comptable. releve : relevé de compte / récapitulatif / relevé de factures qui LISTE plusieurs factures du fournisseur (ce n'est pas une facture). autre : bon de livraison, CGV, devis, relance, publicité…",
    ),
  fournisseur: z.string().describe("raison sociale du fournisseur qui émet le document"),
  numero: z.string().describe("numéro de la facture, de l'avoir ou du relevé, chaîne vide si absent"),
  date_facture: z.string().describe("date du document au format AAAA-MM-JJ, chaîne vide si absente"),
  date_echeance: z.string().describe("date d'échéance AAAA-MM-JJ, chaîne vide si absente"),
  montant_ht: z.number().nullable().describe("facture/avoir : total hors taxes en euros"),
  montant_tva: z.number().nullable().describe("facture/avoir : total de TVA en euros"),
  montant_ttc: z.number().nullable().describe("facture/avoir : total TTC / net à payer. relevé : total des factures et avoirs de la période (hors solde antérieur)"),
  net_a_payer: z.number().nullable().describe("relevé : net / solde à payer indiqué (peut inclure le solde antérieur et déduire les règlements), null si absent"),
  compte_client: z.string().describe("relevé : n° de compte client ou adresse de livraison, chaîne vide si absent"),
  periode_debut: z.string().describe("relevé : premier jour de la période AAAA-MM-JJ, sinon chaîne vide"),
  periode_fin: z.string().describe("relevé : dernier jour de la période AAAA-MM-JJ, sinon chaîne vide"),
  solde_anterieur: z.number().nullable().describe("relevé : solde reporté d'avant la période en euros, null si absent"),
  lignes: z
    .array(
      z.object({
        numero: z.string().describe("numéro de la facture ou de l'avoir listé"),
        date: z.string().describe("date AAAA-MM-JJ, chaîne vide si absente"),
        montant_ttc: z.number().nullable().describe("montant TTC en euros, tel qu'écrit (valeur positive)"),
        avoir: z.boolean().describe("true si la ligne est un avoir / note de crédit"),
      }),
    )
    .describe("relevé : chaque facture et avoir listé, dans l'ordre. Facture seule : liste vide."),
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

export interface ReleveLigne {
  numero: string;
  date?: string;
  montantTTC: number; // centimes, négatif pour un avoir
}

/** Relevé / récapitulatif mensuel d'un fournisseur : document de contrôle, pas une facture. */
export interface ExtractedReleve {
  kind: "releve";
  fournisseur?: string;
  numero?: string;
  dateReleve?: string;
  periodeDebut?: string;
  periodeFin?: string;
  totalTTC?: number;
  soldeAnterieur?: number;
  netAPayer?: number;
  compteClient?: string;
  lignes: ReleveLigne[];
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

async function ask<S extends z.ZodType>(lecteur: Lecteur, schema: S, content: Anthropic.Beta.BetaContentBlockParam[]): Promise<z.infer<S> | null> {
  const modele = lecteur.reglages.modele;
  const res = await anthropic().beta.messages.parse({
    model: MODELES[modele].id,
    max_tokens: 8000,
    // Repli automatique en cas de refus (Haiku n'en a pas côté serveur).
    ...(modele === "haiku" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
    system: SYSTEM,
    output_config: { effort: "low", format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content }],
  });
  lecteur.compter(res.usage);
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") return null;
  return (res.parsed_output as z.infer<S> | null) ?? null;
}

const contextLine = (c: { from: string; subject: string; filename?: string }) =>
  `Mail de : ${c.from}\nObjet : ${c.subject}${c.filename ? `\nPièce jointe : ${c.filename}` : ""}`;

/**
 * Facture ou avoir (montants d'un avoir rendus négatifs), relevé de factures (kind « releve »),
 * ou null si le PDF n'est ni l'un ni l'autre (bon de livraison, CGV…).
 */
export async function extractFacture(
  pdfBase64: string,
  ctx: { from: string; subject: string; filename: string },
  lecteur: Lecteur,
): Promise<ExtractedFacture | ExtractedReleve | null> {
  const r = await ask(lecteur, FactureSchema, [
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
    { type: "text", text: `${contextLine(ctx)}\n\nDe quel document s'agit-il ? Relève ses informations.` },
  ]);
  if (!r || r.type_document === "autre") return null;
  if (r.type_document === "releve") {
    const lignes = r.lignes
      .map((l) => {
        const c = cents(l.montant_ttc === null ? null : Math.abs(l.montant_ttc));
        return c === undefined || !l.numero.trim() ? null : { numero: l.numero.trim().slice(0, 60), ...(iso(l.date) ? { date: iso(l.date) } : {}), montantTTC: l.avoir ? -c : c };
      })
      .filter((l): l is ReleveLigne => l !== null)
      .slice(0, 300);
    return clean({
      kind: "releve" as const,
      fournisseur: r.fournisseur.trim(),
      numero: r.numero.trim(),
      dateReleve: iso(r.date_facture),
      periodeDebut: iso(r.periode_debut),
      periodeFin: iso(r.periode_fin),
      totalTTC: cents(r.montant_ttc),
      soldeAnterieur: cents(r.solde_anterieur),
      netAPayer: cents(r.net_a_payer),
      compteClient: r.compte_client.trim().slice(0, 200),
      lignes,
    });
  }
  const sign = r.type_document === "avoir" ? -1 : 1;
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
  lecteur: Lecteur,
): Promise<ExtractedUber | null> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (pdfBase64) content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } });
  content.push({
    type: "text",
    text: `${contextLine(ctx)}\nReçu le : ${ctx.receivedAt}\n\nCorps du mail :\n${text}\n\nCe message annonce-t-il un versement d'Uber Eats au restaurant ? Si oui, relève-le.`,
  });
  const r = await ask(lecteur, UberSchema, content);
  if (!r || !r.est_versement) return null;
  return clean({
    date: iso(r.date_versement),
    montant: cents(r.montant_net),
    brut: cents(r.ventes_brutes),
    frais: cents(r.frais === null ? null : Math.abs(r.frais)),
    reference: r.reference.trim(),
  });
}

export const estReleve = (r: ExtractedFacture | ExtractedReleve): r is ExtractedReleve => (r as ExtractedReleve).kind === "releve";
