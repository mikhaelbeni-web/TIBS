import { describe, expect, it } from "vitest";
import { aContester, bilan, etatDepuisTexte, lireCopieUber, messageParDefaut, montantSaisi, nouvelleFiche, parMois } from "../contestations";

// Copie du tableau d'Uber Eats Manager telle que le navigateur la colle (une cellule par ligne ou par tabulation).
const COPIE = `9FE82
Tib's (K)	05/11/2026	12:59	Jeremy D	Livraison Eats	--
Mauvaise commande reçue
Contestation refusée
57FF6	Tib's (K)	04/11/2026	18:52	Johny S	Livraison Eats	Samba S
Mauvaise commande reçue
Justificatif joint
Problème facturé
D85E0	Tib's (K)	03/11/2026	13:53	Shaun E	Livraison Eats	Arman Hussain M	1 article endommagé	Remboursement effectué par Uber
F26D0	Tib's (K)	03/11/2026	00:15	Shanael A	Livraison Eats	Mohammad Naseem S	Commande reçue en retard	Remboursement effectué par Uber
35D9E	Tib's (K)	01/11/2026	00:21	Baj C	Livraison Eats	Shakil Ahmed M	Commande non reçue	Remboursement effectué par Uber`;

describe("lireCopieUber", () => {
  const lignes = lireCopieUber(COPIE);
  it("reconnaît les 5 commandes", () => {
    expect(lignes.map((l) => l.commande)).toEqual(["9FE82", "57FF6", "D85E0", "F26D0", "35D9E"]);
  });
  it("lit date, heure, client, motif et état", () => {
    expect(lignes[1]).toEqual({
      commande: "57FF6",
      dateCommande: "2026-11-04",
      heure: "18:52",
      client: "Johny S",
      motif: "Mauvaise commande reçue",
      etatUber: "probleme_facture",
      justificatif: true,
    });
    expect(lignes[0].etatUber).toBe("contestation_refusee");
    expect(lignes[2].motif).toBe("1 article endommagé");
    expect(lignes[2].etatUber).toBe("rembourse_uber");
  });
  it("ignore un texte sans commande", () => {
    expect(lireCopieUber("Affichage de 5 résultats Réinitialiser")).toEqual([]);
  });
});

describe("règle de contestation", () => {
  it("ne conteste que Problème facturé et Remboursement effectué par Uber", () => {
    expect(aContester(etatDepuisTexte("Problème facturé"))).toBe(true);
    expect(aContester(etatDepuisTexte("Remboursement effectué par Uber"))).toBe(true);
    expect(aContester(etatDepuisTexte("Contestation refusée"))).toBe(false);
  });
  it("crée la fiche à contester avec un message adapté au motif", () => {
    const [refusee, facturee, , retard] = lireCopieUber(COPIE).map((l) => nouvelleFiche(l, 1));
    expect(facturee.issue).toBe("a_contester");
    expect(facturee.commentaire).toContain("deux équipiers");
    expect(refusee.issue).toBe("abandonnee");
    expect(retard.commentaire).toContain("livraison");
    expect(messageParDefaut("Commande non reçue")).toContain("livraison");
  });
});

describe("bilan", () => {
  it("sépare récupéré, en attente et perdu", () => {
    const b = bilan([
      { issue: "acceptee", montant: 1500 },
      { issue: "acceptee", montant: 2000, montantRecupere: 1200 },
      { issue: "contestee", montant: 900 },
      { issue: "refusee", montant: 700 },
      { issue: "a_contester" },
    ]);
    expect(b).toEqual({ nombre: 5, retenu: 5100, recupere: 2700, enAttente: 900, perdu: 1500, sansMontant: 1 });
  });
  it("groupe par mois, le plus récent d'abord", () => {
    const g = parMois([{ dateCommande: "2026-10-30" }, { dateCommande: "2026-11-02" }, { dateCommande: "2026-11-01" }]);
    expect(g.map(([m, l]) => [m, l.length])).toEqual([["2026-11", 2], ["2026-10", 1]]);
  });
  it("lit un montant saisi", () => {
    expect(montantSaisi("12,50")).toBe(1250);
    expect(montantSaisi("-8 €")).toBe(800);
    expect(montantSaisi("")).toBeUndefined();
  });
});
