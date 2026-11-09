import type { InboxDoc } from "./ingest";

const cle = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");

/**
 * Retrouve le mail d'origine d'une facture validée à la main avant que l'id du mail soit enregistré sur la facture :
 * même numéro, puis même montant TTC ou même fournisseur. Renvoie l'id de la ligne « À vérifier », sinon null.
 */
export function inboxDeLaFacture(
  facture: { numero: string; montantTTC: number; supplierNom: string },
  candidats: { id: string; data: Pick<InboxDoc, "item" | "statut"> }[],
): string | null {
  const numero = cle(facture.numero);
  if (!numero) return null;
  const memes = candidats.filter(
    (c) => c.data.item.kind === "facture" && c.data.item.source.attachment && cle(c.data.item.numero ?? "") === numero && c.data.statut !== "rejete",
  );
  const score = (c: (typeof memes)[number]) => {
    const it = c.data.item as Extract<InboxDoc["item"], { kind: "facture" }>;
    return (it.montantTTC === facture.montantTTC ? 2 : 0) + (cle(it.fournisseur) === cle(facture.supplierNom) ? 1 : 0) + (c.data.statut === "valide" ? 1 : 0);
  };
  const best = memes.sort((a, b) => score(b) - score(a))[0];
  return best && score(best) >= 2 ? best.id : null;
}
