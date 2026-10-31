// Modèle de données Firestore. Montants en centimes (entiers) pour éviter les erreurs d'arrondi.

export type Role = "gerant" | "employe";

/** users/{uid} : créé à la main dans la console (voir README). */
export interface AppUser {
  email: string;
  role: Role;
}

export type TypeContrat = "CDI" | "CDD" | "Apprentissage" | "Extra" | "Interim";

export type StatutDpae = "a_declarer" | "declaree";

/** employees/{id} */
export interface Employee {
  nom: string;
  nomNaissance?: string;
  prenom: string;
  sexe: "M" | "F";
  nir: string; // numéro de sécurité sociale (15 chiffres avec clé)
  dateNaissance: string; // AAAA-MM-JJ
  lieuNaissance: string; // commune
  departementNaissance: string; // "75", "2A", "99" si né à l'étranger
  nationalite: string;
  adresse?: string;
  dateEmbauche: string; // AAAA-MM-JJ
  heureEmbauche: string; // HH:MM
  typeContrat: TypeContrat;
  dateFinContrat?: string; // obligatoire pour CDD
  poste: string;
  dpaeStatut: StatutDpae;
  dpaeDateDeclaration?: string;
  dpaeNumeroAccuse?: string;
  createdAt: number;
}

/** suppliers/{id} */
export interface Supplier {
  nom: string;
  siret?: string;
  email?: string;
  categorie?: string; // boissons, viande, emballage…
  createdAt: number;
}

export type StatutFacture = "a_payer" | "payee" | "litige";

/** invoices/{id} */
export interface Invoice {
  supplierId: string;
  supplierNom: string;
  numero: string;
  dateFacture: string; // AAAA-MM-JJ
  dateEcheance?: string;
  mois: string; // AAAA-MM, dérivé de dateFacture
  montantHT: number; // centimes
  montantTVA: number; // centimes
  montantTTC: number; // centimes
  statut: StatutFacture;
  datePaiement?: string;
  note?: string;
  createdAt: number;
}

/** cashEntries/{AAAA-MM-JJ} : un Z de caisse / TD collecte par jour (l'id du document est la date). */
export interface CashEntry {
  date: string; // AAAA-MM-JJ
  cb: number; // centimes encaissés en carte
  especes: number;
  ticketsResto: number;
  autres: number;
  /** Ventes TTC ventilées par taux de TVA (centimes), si la caisse les fournit. */
  ttc55?: number;
  ttc10?: number;
  ttc20?: number;
  note?: string;
  createdAt: number;
}

/** settings/app */
export interface AppSettings {
  comptableEmail?: string;
  comptableNom?: string;
}

/** bankTransactions/{id} : lignes importées du relevé (id déterministe pour éviter les doublons). */
export interface BankTransaction {
  date: string; // AAAA-MM-JJ
  libelle: string;
  montant: number; // centimes, positif = crédit
  importId: string;
  createdAt: number;
}

export type WithId<T> = T & { id: string };
