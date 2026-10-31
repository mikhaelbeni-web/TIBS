import { describe, expect, it } from "vitest";
import { bodyText, classify, DEFAULT_RULES, displayNameOf, emailOf, gmailQuery, mergeRules, pdfAttachments, senderMatches, type GmailMessage } from "../mail";

const b64 = (s: string) => Buffer.from(s).toString("base64url");

function msg(from: string, subject: string, files: string[] = [], html = ""): GmailMessage {
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
        ...files.map((f, i) => ({ mimeType: "application/pdf", filename: f, body: { attachmentId: `att${i}`, size: 1000 } })),
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
    expect(classify(msg("Uber Eats <noreply@uber.com>", "Votre paiement hebdomadaire"), rules, [])).toBe("uber");
    expect(classify(msg("Uber <noreply@uber.com>", "Votre course de mardi soir"), rules, [])).toBeNull();
    expect(classify(msg("Metro <f@metro.fr>", "Votre facture n°123", ["doc.pdf"]), rules, [])).toBe("facture");
    expect(classify(msg("Metro <f@metro.fr>", "Document", ["FAC_2026_10.pdf"]), rules, [])).toBe("facture");
    expect(classify(msg("Boucherie <b@boucher.fr>", "Octobre", ["releve.pdf"]), rules, ["b@boucher.fr"])).toBe("facture");
    expect(classify(msg("Ami <a@gmail.com>", "Photos", ["vacances.pdf"]), rules, [])).toBeNull();
    expect(classify(msg("Metro <f@metro.fr>", "Votre facture", []), rules, [])).toBeNull();
    expect(classify(msg("Banque <x@banque.fr>", "Facture", ["a.pdf"]), mergeRules({ ignorer: ["banque.fr"] }), [])).toBeNull();
  });

  it("construit la requête Gmail", () => {
    expect(gmailQuery(3, DEFAULT_RULES)).toBe("newer_than:3d -in:spam -in:trash (has:attachment filename:pdf OR from:uber.com OR from:ubereats.com)");
  });
});
