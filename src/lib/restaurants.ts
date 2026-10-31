/**
 * Les deux restaurants, gérés comme deux portails séparés : chaque donnée vit sous restaurants/{id}/…
 * (salariés, fournisseurs, factures, caisse, banque, Uber, TVA, boîte mail).
 */
export type RestaurantId = "19e" | "17e";

export interface Restaurant {
  id: RestaurantId;
  court: string; // « Manin 19e »
  nom: string;
  adresse: string;
  societe?: string;
  boiteMail: string; // boîte Gmail proposée à la connexion
  /** Classe Tailwind de la couleur d'identification (pastille, carré). */
  couleur: string;
  /** Texte lisible sur cette couleur. */
  surCouleur: string;
}

export const RESTAURANTS: Restaurant[] = [
  {
    id: "19e",
    court: "Manin 19e",
    nom: "Le Tib's Manin",
    adresse: "161 rue Manin, 75019 Paris",
    societe: "SAS AVA",
    boiteMail: "ava01012018@gmail.com",
    couleur: "bg-site-19",
    surCouleur: "text-ink",
  },
  {
    id: "17e",
    court: "Prony 17e",
    nom: "Le Tib's Prony",
    adresse: "48 rue de Prony, 75017 Paris",
    boiteMail: "letibsprony17@gmail.com",
    couleur: "bg-site-17",
    surCouleur: "text-white",
  },
];

export const RESTAURANT_IDS = RESTAURANTS.map((r) => r.id);
export const DEFAULT_RESTAURANT: RestaurantId = "19e";

export function isRestaurantId(v: unknown): v is RestaurantId {
  return typeof v === "string" && (RESTAURANT_IDS as string[]).includes(v);
}

export function restaurant(id: RestaurantId): Restaurant {
  return RESTAURANTS.find((r) => r.id === id)!;
}
