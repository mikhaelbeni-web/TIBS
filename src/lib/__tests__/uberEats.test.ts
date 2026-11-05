import { describe, expect, it } from "vitest";
import { antiRobot, codeUberDepuisMail, contestationConfirmee, demandeCode, ligneDeLaBoutique, montantRetenu } from "../uberEats";

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
  });
  it("repère l'anti-robot et filtre par boutique", () => {
    expect(antiRobot("Vérifiez que vous êtes humain")).toBe(true);
    expect(ligneDeLaBoutique("57FF6\tTib's (K)\t04/11/2026", "tib's (k)")).toBe(true);
    expect(ligneDeLaBoutique("57FF6\tTib's (P)\t04/11/2026", "Tib's (K)")).toBe(false);
    expect(ligneDeLaBoutique("57FF6", "")).toBe(true);
  });
});
