import { describe, expect, it } from "vitest";
import {
  bodyText,
  classify,
  DEFAULT_RULES,
  detectEtablissement,
  displayNameOf,
  emailOf,
  frenchCents,
  gmailQuery,
  knownSupplier,
  mergeRules,
  parseFactureText,
  parseUberRecap,
  pdfAttachments,
  senderMatches,
  type GmailMessage,
} from "../mail";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function msg(from: string, subject: string, files: string[] = [], html = "", mime = "application/pdf"): GmailMessage {
  return {
    id: "18c0ffee",
    internalDate: String(Date.UTC(2026, 9, 15, 8)),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: from },
        { name: "Subject", value: subject },
      ],
      parts: [
        { mimeType: "multipart/alternative", parts: [{ mimeType: "text/html", body: { data: b64(html), size: html.length } }] },
        ...files.map((f, i) => ({ mimeType: mime, filename: f, body: { attachmentId: `att${i}`, size: 1000 } })),
      ],
    },
  };
}

describe("mail", () => {
  it("lit l'expéditeur", () => {
    expect(emailOf('"Metro France" <Factures@Metro.fr>')).toBe("factures@metro.fr");
    expect(displayNameOf('"Metro France" <factures@metro.fr>')).toBe("Metro France");
    expect(displayNameOf("compta@brasserie-dupont.fr")).toBe("brasserie-dupont");
    expect(senderMatches("noreply@eats.uber.com", ["uber.com"])).toBe(true);
    expect(senderMatches("noreply@notuber.com", ["uber.com"])).toBe(false);
    expect(senderMatches("a@b.fr", ["a@b.fr"])).toBe(true);
  });

  it("trouve les PDF et le texte", () => {
    const m = msg("x@y.fr", "Votre facture", ["FAC-001.pdf", "cgv.pdf"], "<p>Total&nbsp;: 12,50&euro;</p><br>Merci");
    expect(pdfAttachments(m).map((p) => p.filename)).toEqual(["FAC-001.pdf", "cgv.pdf"]);
    expect(bodyText(m)).toBe("Total : 12,50€\nMerci");
  });

  it("trie les mails", () => {
    const rules = DEFAULT_RULES;
    expect(classify(msg("Uber Eats <noreply@uber.com>", "Récapitulatif des versements Uber Eats pour Tib's (K) Oct 19, 2026 - Oct 25, 2026"), rules, [])).toBe("uber");
    expect(classify(msg("Uber Eats <restaurantsfrance@uber.com>", "Récapitulatif de paiement Uber Eats de Tib's (K) du 7/20/26 au 7/26/26"), rules, [])).toBe("uber");
    expect(classify(msg("Uber <noreply@uber.com>", "[Business] Votre course de mardi soir"), rules, [])).toBeNull();
    expect(classify(msg("Uber <noreply@uber.com>", "Your Uber Eats Monthly Statement is Ready"), rules, [])).toBeNull();
    // Fournisseur connu : PDF en octet-stream accepté grâce à l'extension.
    expect(classify(msg("Label Délice <secretariat@labeldelice.fr>", "Document", ["F123.pdf"], "", "application/octet-stream"), rules, [])).toBe("facture");
    expect(classify(msg("HPS <comptabilite@hpsrungis.com>", "Relance facture", ["a.pdf"]), rules, [])).toBeNull();
    // Fournisseur connu sans PDF mais montant dans le mail (Pennylane).
    expect(classify(msg("SMEL <smel-distrib@invoicing.pennylane.com>", "Nouvelle facture", [], "<p>d'un montant de 132,19 € à régler avant le 23/10/2026</p>"), rules, [])).toBe("facture");
    expect(classify(msg("Metro <f@metro.fr>", "Votre facture n°123", ["doc.pdf"]), rules, [])).toBe("facture");
    expect(classify(msg("Metro <f@metro.fr>", "Document", ["FAC_2026_10.pdf"]), rules, [])).toBe("facture");
    expect(classify(msg("Boucherie <b@boucher.fr>", "Octobre", ["releve.pdf"]), rules, ["b@boucher.fr"])).toBe("facture");
    expect(classify(msg("Ami <a@gmail.com>", "Photos", ["vacances.pdf"]), rules, [])).toBeNull();
    expect(classify(msg("Metro <f@metro.fr>", "Votre facture", []), rules, [])).toBeNull();
    expect(classify(msg("Julien <compta1@jds-associes.com>", "Factures manquantes AVA", ["liste.pdf"]), rules, [])).toBeNull();
    expect(classify(msg("Banque <x@banque.fr>", "Facture", ["a.pdf"]), mergeRules({ ignorer: ["banque.fr"] }), [])).toBeNull();
  });

  it("reconnaît les fournisseurs connus", () => {
    const f = DEFAULT_RULES.fournisseurs;
    expect(knownSupplier("comptabilite@hpsrungis.com", f)).toBe("Halles Paris Sud");
    expect(knownSupplier("ims-cash@invoicing.pennylane.com", f)).toBe("IMS Cash");
    expect(knownSupplier("autre@invoicing.pennylane.com", f)).toBeNull();
    expect(knownSupplier("x@gmail.com", f)).toBeNull();
  });

  it("lit les montants écrits dans le mail", () => {
    expect(frenchCents("4 781,33")).toBe(478133);
    expect(frenchCents("1.234,56")).toBe(123456);
    expect(frenchCents("-1 840,69")).toBe(-184069);
    expect(parseFactureText("Nouvelle facture SMEL", "Facture F-2026-09-162 d'un montant de 132,19 € à régler avant le 23/10/2026")).toEqual({
      montantTTC: 13219,
      dateEcheance: "2026-10-23",
      numero: "F-2026-09-162",
    });
    expect(parseFactureText("[DUPLICATA] Facture", "Montant TTC de la facture : 419.02 EUR\nDate de la facture : 2026-10-12")).toMatchObject({
      montantTTC: 41902,
      dateFacture: "2026-10-12",
    });
    expect(parseFactureText("Facture - FAC53820 - 304,22 € TTC", "")).toMatchObject({ montantTTC: 30422, numero: "FAC53820" });
    expect(parseFactureText("Votre facture FAC-20261027-004512", "")).toEqual({ numero: "FAC-20261027-004512", dateFacture: "2026-10-27" });
    expect(parseFactureText("Facture", "Veuillez trouver la facture en date du 27102026")).toEqual({ dateFacture: "2026-10-27" });
  });

  it("lit le récap Uber hebdo", () => {
    const body = "Revenus totaux | 7 806,50 €\nTotal des frais Uber | -1 840,69 €\nVersement bancaire | 4 781,33 €\nTitres-restaurant | 145,05 €\nVersement net | 4 926,38 €";
    expect(parseUberRecap("Récapitulatif des versements Uber Eats pour Tib's (K) Oct 19, 2026 - Oct 25, 2026", body)).toEqual({
      debut: "2026-10-19",
      fin: "2026-10-25",
      periode: "19/10/2026 au 25/10/2026",
      versementBancaire: 478133,
      titresRestaurant: 14505,
      versementNet: 492638,
      fraisUber: -184069,
      revenusTotaux: 780650,
    });
    expect(parseUberRecap("Récapitulatif de paiement Uber Eats de Tib's (K) du 7/20/26 au 7/26/26", "")).toMatchObject({ debut: "2026-07-20", fin: "2026-07-26" });
  });

  it("devine l'établissement", () => {
    expect(detectEtablissement("Livraison 48 rue de Prony 75017 Paris")).toBe("17e");
    expect(detectEtablissement("SAS AVA 161 rue Manin 75019")).toBe("19e");
    expect(detectEtablissement("Facture du mois")).toBeUndefined();
    expect(detectEtablissement("cc letibsprony17@gmail.com et rue Manin")).toBeUndefined();
  });

  it("construit la requête Gmail", () => {
    const q = gmailQuery(3, DEFAULT_RULES);
    expect(q.startsWith("newer_than:3d -in:sent -in:spam -in:trash -from:me -category:promotions (has:attachment filename:pdf OR from:(noreply@uber.com OR restaurantsfrance@uber.com OR hpsrungis.com")).toBe(true);
  });
});
