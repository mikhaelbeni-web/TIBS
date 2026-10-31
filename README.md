# TIBS – Gestion interne du restaurant

Application web (pensée d'abord pour le téléphone) pour :

- **Salariés et DPAE** : saisie ou import Excel/CSV, contrôle des données obligatoires (dont la clé du NIR), fiche à recopier sur net-entreprises.fr, suivi de l'accusé de réception.
- **Factures fournisseurs** : saisie mensuelle, statut à payer / payée / litige, totaux HT/TVA/TTC, export CSV pour le comptable.
- **Pointage caisse / banque** : import des journées de caisse et du relevé bancaire, rapprochement automatique des remises CB (commission et délai paramétrables) et des dépôts d'espèces (plusieurs jours par dépôt).
- **TVA** : TVA collectée (ventes ventilées 5,5 / 10 / 20 %) moins TVA déductible (factures), par mois, trimestre ou dates libres ; export CSV et e-mail pré-rempli au comptable.

Stack : Next.js 16, React 19, Tailwind CSS 4, Firebase (Authentication + Firestore).

## Démarrer

Node 24 recommandé (le SDK Firebase le demande).

```bash
npm install
cp .env.example .env.local   # puis compléter NEXT_PUBLIC_FIREBASE_API_KEY
npm run dev
```

## Mise en place Firebase (une seule fois)

1. Console Firebase > **Authentication** > Méthodes de connexion : activer **E-mail/Mot de passe**, puis créer votre compte dans l'onglet Utilisateurs. Copier son **UID**.
2. **Firestore Database** : créer la base (région `eur3` ou `europe-west`).
3. Firestore > Données : créer la collection `users`, document dont l'ID est votre UID, avec les champs `email` (texte) et `role` = `gerant` (texte).
4. Publier les règles de sécurité : copier `firestore.rules` dans Firestore > Règles, ou `npx firebase-tools deploy --only firestore:rules`.
5. Authentication > Paramètres > Domaines autorisés : ajouter le domaine exact de déploiement (ex. `tibs.vercel.app`), et chaque domaine d'aperçu utilisé. Les jokers (`*.vercel.app`) ne sont pas acceptés.

Seuls les comptes avec `role: "gerant"` accèdent aux données. Le rôle ne peut pas être modifié depuis l'application.

## Données (Firestore)

Montants stockés en **centimes** (entiers).

| Collection | Contenu |
|---|---|
| `users/{uid}` | rôle de l'utilisateur |
| `employees` | salariés et statut DPAE (contient le NIR : donnée sensible) |
| `suppliers` | fournisseurs |
| `invoices` | factures fournisseurs |
| `cashEntries/{AAAA-MM-JJ}` | une journée de caisse (CB, espèces, tickets resto, autres, ventes TTC par taux) |
| `bankTransactions` | lignes du relevé (ID déterministe : réimporter ne crée pas de doublon) |
| `settings/app` | e-mail du comptable |

## Formats d'import

- Salariés : voir `public/modele-salaries.csv` (en-têtes souples, accents et casse ignorés).
- Caisse : `Date ; CB ; Espèces ; Tickets resto ; Autres ; TTC 5,5 ; TTC 10 ; TTC 20`. Plusieurs lignes d'un même jour sont additionnées. Format provisoire en attendant un export réel de L'Addition.
- Relevé bancaire : `Date ; Libellé ; Montant` ou `Date ; Libellé ; Débit ; Crédit`, CSV (UTF-8 ou Windows-1252) ou `.xlsx`.

## Développement local sans toucher la vraie base

```bash
npm run emulators            # nécessite Java
# .env.development.local :
#   NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-tibs
#   NEXT_PUBLIC_USE_EMULATORS=1
npm run dev
```

## Tests

```bash
npm test    # logique métier : NIR/DPAE, imports, rapprochement, TVA
npm run lint
```
