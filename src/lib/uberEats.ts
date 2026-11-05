import { toCents } from "./money";

/**
 * Lecture du texte d'Uber Eats Manager et des mails d'Uber, sans navigateur (testable).
 * Le robot (src/lib/server/uberEatsBot.ts) s'en sert sur ce qu'il voit à l'écran.
 */

export const UBER_MANAGER_URL = process.env.UBER_MANAGER_URL || "https://merchants.ubereats.com/manager/";

const plat = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** Code de connexion envoyé par Uber par mail (« Votre code Uber : 1234 »). */
export function codeUberDepuisMail(sujet: string, corps: string): string | null {
  for (const t of [sujet, corps]) {
    const m = plat(t).match(/code[^0-9]{0,60}(\d{4,6})\b/) ?? plat(t).match(/\b(\d{4,6})\b[^0-9]{0,40}code/);
    if (m) return m[1];
  }
  const seul = sujet.match(/\b(\d{4,6})\b/);
  return seul ? seul[1] : null;
}

/**
 * Montant retenu au restaurant, lu dans le détail d'une commande :
 * on cherche une ligne d'ajustement / d'erreur / de remboursement qui porte un montant en euros.
 */
export function montantRetenu(texte: string): number | null {
  const lignes = texte.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const MOTS = /ajustement|erreur|rembours|deduit|retenu|imput|facture au restaurant|frais de probleme|probleme facture/;
  const MONTANT = /[-−–]?\s*\d{1,4}(?:[   ]?\d{3})*[,.]\d{2}\s*€|€\s*[-−–]?\s*\d{1,4}[,.]\d{2}/;
  for (let i = 0; i < lignes.length; i++) {
    if (!MOTS.test(plat(lignes[i]))) continue;
    // Le montant est sur la même ligne ou juste après (cellule voisine).
    for (const l of [lignes[i], lignes[i + 1] ?? ""]) {
      const m = l.match(MONTANT);
      if (m) {
        const c = toCents(m[0].replace(/[−–]/g, "-"));
        if (c !== null && c !== 0) return Math.abs(c);
      }
    }
  }
  return null;
}

/** La page affiche-t-elle une confirmation d'envoi de contestation ? */
export function contestationConfirmee(texte: string): boolean {
  const t = plat(texte);
  return /contestation (a ete )?(envoyee|soumise|enregistree|recue)|demande (a ete )?(envoyee|soumise|enregistree)|nous examinerons|merci pour votre (contestation|demande)|en cours d'examen|contestation en cours/.test(t);
}

/** La page de connexion réclame-t-elle un code (SMS ou mail) ? */
export function demandeCode(texte: string): "sms" | "mail" | "inconnu" | null {
  const t = plat(texte);
  if (!/code/.test(t) || !/(saisi|entre|envoy|recu|verification|4 chiffres|6 chiffres)/.test(t)) return null;
  if (/sms|telephone|\+33|numero/.test(t) && !/e-?mail|adresse/.test(t)) return "sms";
  if (/e-?mail|adresse|boite/.test(t)) return "mail";
  return "inconnu";
}

/** Uber a-t-il affiché une vérification anti-robot ? */
export function antiRobot(texte: string): boolean {
  return /captcha|verifiez que vous etes humain|verify you are human|are you a robot|etes-vous un robot|puzzle/.test(plat(texte));
}

/** Boutique « Tib's (K) » : ne garder que les lignes de la boutique de ce restaurant, si elle est renseignée. */
export function ligneDeLaBoutique(ligne: string, boutique: string): boolean {
  return !boutique.trim() || plat(ligne).includes(plat(boutique.trim()));
}
