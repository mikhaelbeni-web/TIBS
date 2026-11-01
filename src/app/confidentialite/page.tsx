import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Confidentialité et conditions – Le Tib's gestion",
  robots: { index: false, follow: false },
};

export default function ConfidentialitePage() {
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-sm leading-relaxed">
      <h1 className="mb-6 font-display text-3xl">Le Tib&apos;s gestion</h1>

      <h2 className="mt-6 mb-2 text-lg font-semibold">Règles de confidentialité</h2>
      <p>
        Le Tib&apos;s gestion est l&apos;outil interne de gestion des restaurants Le Tib&apos;s (Paris 19e et Paris 17e). Il est
        réservé aux gérants de ces restaurants et n&apos;est pas proposé au public.
      </p>
      <p className="mt-3">
        Quand un gérant connecte la boîte Gmail d&apos;un restaurant, l&apos;application lit en lecture seule (autorisation
        gmail.readonly) les e-mails de fournisseurs et d&apos;Uber Eats afin d&apos;en extraire les factures et les versements
        (fournisseur, numéro, dates, montants). Ces informations sont enregistrées dans la base de données du restaurant
        (Google Firebase) pour la comptabilité interne.
      </p>
      <p className="mt-3">
        L&apos;application n&apos;envoie, ne supprime et ne déplace aucun e-mail. Les données Gmail ne sont ni vendues, ni
        partagées avec des tiers, ni utilisées à des fins publicitaires. Si l&apos;option de lecture automatique des PDF est
        activée, le contenu d&apos;une facture est transmis à l&apos;API d&apos;Anthropic (Claude) uniquement pour en extraire
        les montants. L&apos;usage des données reçues des API Google respecte la{" "}
        <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">
          Google API Services User Data Policy
        </a>
        , y compris les exigences d&apos;usage limité.
      </p>
      <p className="mt-3">
        La connexion peut être retirée à tout moment depuis l&apos;application (« Déconnecter ») ou depuis
        myaccount.google.com/permissions. Contact : mikhaelbeni@gmail.com.
      </p>

      <h2 id="conditions" className="mt-8 mb-2 text-lg font-semibold">
        Conditions d&apos;utilisation
      </h2>
      <p>
        L&apos;accès est limité aux comptes créés par l&apos;exploitant des restaurants. Chaque utilisateur est responsable de
        la confidentialité de ses identifiants. L&apos;outil est fourni pour la gestion interne des restaurants Le Tib&apos;s,
        sans garantie de disponibilité ; les données saisies restent la propriété de l&apos;exploitant.
      </p>
    </main>
  );
}
