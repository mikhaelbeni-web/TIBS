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
  /** Virement : à payer par le gérant. Prélèvement : le fournisseur se sert, à contrôler. Défaut : virement. */
  paiement?: ModePaiement;
  iban?: string;
  /** Mots du libellé bancaire du prélèvement (ex. « METRO, MAKRO »), sinon le nom du fournisseur. */
  libelleBanque?: string;
  createdAt: number;
}

export type ModePaiement = "virement" | "prelevement";

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
  /** Comment la facture a été réglée (renseigné au marquage « Virement fait » / « Contrôlé »). */
  paiement?: ModePaiement;
  note?: string;
  /** Restaurant concerné : 19e (SAS AVA, rue Manin) ou 17e (rue de Prony). */
  etablissement?: "19e" | "17e";
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
  /** Lu sur le ticket Z : montant Uber, nombre de commandes Uber, total imprimé, détail des paiements. */
  uber?: number;
  uberCommandes?: number;
  total?: number;
  paiements?: { libelle: string; montant: number; categorie: string; nombre?: number }[];
  source?: "manuel" | "import" | "ticketZ";
  ticketZ?: { dateTicket: string; heureCloture?: string; luLe: number };
  createdAt: number;
}

/** uberJours/{AAAA-MM-JJ} : ventes Uber Eats d'une journée (export des commandes du Manager). */
export interface UberJourDoc {
  date: string;
  commandes: number;
  ventes: number; // centimes TTC
  /** Premier / dernier jour d'un export : des commandes peuvent manquer. */
  partiel?: boolean;
  createdAt: number;
}

/** settings/app */
export interface AppSettings {
  comptableEmail?: string;
  comptableNom?: string;
  /** Mois de TVA envoyés au comptable : { "2026-10": "2026-11-08" } (date d'envoi). */
  tvaEnvois?: Record<string, string>;
}

/** bankTransactions/{id} : lignes importées du relevé (id déterministe pour éviter les doublons). */
export interface BankTransaction {
  date: string; // AAAA-MM-JJ
  libelle: string;
  montant: number; // centimes, positif = crédit
  details?: string; // informations complémentaires de la banque (import de fichier)
  type?: string; // type d'opération donné par la banque (import de fichier)
  importId: string; // "banque" pour le relevé automatique
  /** "banque" = relevé automatique DSP2 ; absent = import de fichier. */
  source?: "banque";
  compte?: string;
  ref?: string;
  createdAt: number;
}

/** uberPayouts/{id} : versements Uber Eats (import du Manager, fiche « À vérifier », ou récap hebdo du mail). */
export interface UberPayout {
  date: string; // AAAA-MM-JJ du versement
  montant: number; // centimes nets versés
  brut?: number; // ventes TTC de la période, si fournies
  frais?: number; // commission / frais Uber, si fournis
  titres?: number; // titres-restaurant versés à part
  debut?: string; // semaine couverte (récap du mail)
  fin?: string;
  source?: "mail" | "import" | "manuel";
  reference?: string;
  createdAt: number;
}

export type WithId<T> = T & { id: string };
