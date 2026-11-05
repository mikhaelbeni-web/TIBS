import { describe, expect, it } from "vitest";
import { antiRobot, codeUberDepuisMail, contestationConfirmee, demandeCode, demandeTelephone, ligneDeLaBoutique, montantRetenu, telephoneInternational } from "../uberEats";

describe("code de connexion Uber par mail", () => {
  it("lit le code dans l'objet ou le corps", () => {
    expect(codeUberDepuisMail("Votre code Uber : 4821", "")).toBe("4821");
    expect(codeUberDepuisMail("Connexion à Uber", "Bonjour, voici votre code de vérification\n 739204 \nIl expire dans 10 minutes.")).toBe("739204");
    expect(codeUberDepuisMail("4821 est votre code Uber", "")).toBe("4821");
    expect(codeUberDepuisMail("Votre récap hebdomadaire", "Versement 1 234,56 €")).toBeNull();
  });
});

describe("montant retenu sur une commande", () => {
  it("prend le montant de la ligne d'ajustement", () => {
    expect(montantRetenu("Sous-total\n24,90 €\nAjustement pour erreur de commande\n-12,45 €\nTotal\n12,45 €")).toBe(1245);
    expect(montantRetenu("Remboursement imputé au restaurant : −8,50 €")).toBe(850);
  });
  it("renvoie null sans ligne d'ajustement", () => {
    expect(montantRetenu("Sous-total 24,90 €\nTotal 24,90 €")).toBeNull();
  });
});

describe("lecture des écrans", () => {
  it("reconnaît la confirmation d'envoi", () => {
    expect(contestationConfirmee("Merci ! Votre contestation a été envoyée. Nous examinerons votre demande.")).toBe(true);
    expect(contestationConfirmee("Contester l'erreur")).toBe(false);
  });
  it("reconnaît une demande de code et son canal", () => {
    expect(demandeCode("Saisissez le code à 4 chiffres envoyé au +33 6 12 34 56 78")).toBe("sms");
    expect(demandeCode("Saisissez le code à 4 chiffres envoyé à l'adresse e-mail a***@gmail.com")).toBe("mail");
    expect(demandeCode("Commandes du jour")).toBeNull();
    // Pages Uber servies en anglais (serveur hors de France).
    expect(demandeCode("Enter the 4-digit code sent to you at t***@gmail.com")).toBe("mail");
    expect(demandeCode("Enter the 4-digit code sent via SMS to your phone number")).toBe("sms");
    expect(demandeCode("What's your phone number or email?")).toBeNull();
    expect(demandeCode("Saisissez le code envoyé par SMS au 06 •• •• •• 91 (compte tibilevana@gmail.com)")).toBe("sms");
  });

  it("reconnaît la page du numéro de téléphone et lit le numéro", () => {
    expect(demandeTelephone("Saisissez votre numéro de téléphone")).toBe(true);
    expect(demandeTelephone("Enter your mobile number")).toBe(true);
    expect(demandeTelephone("Saisissez le code à 4 chiffres")).toBe(false);
    expect(telephoneInternational("06 41 79 14 91")).toBe("+33641791491");
    expect(telephoneInternational("0641791491")).toBe("+33641791491");
    expect(telephoneInternational("+33 6 41 79 14 91")).toBe("+33641791491");
    expect(telephoneInternational("0033641791491")).toBe("+33641791491");
    expect(telephoneInternational("12")).toBeNull();
  });
  it("repère l'anti-robot et filtre par boutique", () => {
    expect(antiRobot("Vérifiez que vous êtes humain")).toBe(true);
    expect(ligneDeLaBoutique("57FF6\tTib's (K)\t04/11/2026", "tib's (k)")).toBe(true);
    expect(ligneDeLaBoutique("57FF6\tTib's (P)\t04/11/2026", "Tib's (K)")).toBe(false);
    expect(ligneDeLaBoutique("57FF6", "")).toBe(true);
  });
});
