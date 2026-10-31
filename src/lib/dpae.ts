import type { Employee } from "./types";

/**
 * Contrôle des données obligatoires d'une DPAE avant soumission sur net-entreprises / urssaf.fr.
 * La DPAE se fait pour chaque embauche, au plus tôt 8 jours avant et au plus tard
 * juste avant la prise de poste. Elle n'est pas mensuelle (la déclaration mensuelle est la DSN).
 */

/** Vérifie la clé d'un NIR (13 chiffres + clé sur 2 chiffres). Gère la Corse (2A/2B). */
export function isValidNir(raw: string): boolean {
  const nir = raw.replace(/\s/g, "").toUpperCase();
  if (!/^[12378]\d{2}(0[1-9]|1[0-2]|[2-9]\d)(\d{2}|2A|2B)\d{6}\d{2}$/.test(nir)) return false;
  const body = nir.slice(0, 13).replace("2A", "19").replace("2B", "18");
  const key = parseInt(nir.slice(13), 10);
  let mod = 0;
  for (const ch of body) mod = (mod * 10 + Number(ch)) % 97;
  return 97 - mod === key;
}

export interface DpaeCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function checkDpae(e: Partial<Employee>, today = new Date().toISOString().slice(0, 10)): DpaeCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const required: [keyof Employee, string][] = [
    ["nom", "Nom"],
    ["prenom", "Prénom"],
    ["sexe", "Sexe"],
    ["dateNaissance", "Date de naissance"],
    ["lieuNaissance", "Commune de naissance"],
    ["departementNaissance", "Département de naissance"],
    ["nationalite", "Nationalité"],
    ["dateEmbauche", "Date d'embauche"],
    ["heureEmbauche", "Heure d'embauche"],
    ["typeContrat", "Type de contrat"],
  ];
  for (const [k, label] of required) if (!e[k]) errors.push(`${label} manquant`);

  if (!e.nir) warnings.push("NIR absent : la DPAE reste possible, mais il faudra le fournir dès que connu");
  else if (!isValidNir(e.nir)) errors.push("NIR invalide (clé de contrôle incorrecte)");

  if (e.typeContrat === "CDD" && !e.dateFinContrat) errors.push("Date de fin obligatoire pour un CDD");

  if (e.dateEmbauche && e.dpaeStatut !== "declaree") {
    const delta = Math.round((Date.parse(e.dateEmbauche) - Date.parse(today)) / 86400000);
    if (delta < 0) errors.push("Embauche déjà commencée : DPAE en retard, à faire immédiatement");
    else if (delta > 8) warnings.push("Embauche dans plus de 8 jours : la DPAE ne peut pas encore être faite");
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Fiche texte à recopier dans le formulaire DPAE en ligne. */
export function dpaeSheet(e: Employee): string {
  const lines = [
    `DPAE – ${e.prenom} ${e.nom}`,
    `Nom de famille : ${e.nomNaissance || e.nom}`,
    `Nom d'usage : ${e.nom}`,
    `Prénom : ${e.prenom}`,
    `Sexe : ${e.sexe === "F" ? "Féminin" : "Masculin"}`,
    `NIR : ${e.nir || "(non connu)"}`,
    `Date de naissance : ${e.dateNaissance}`,
    `Lieu de naissance : ${e.lieuNaissance} (${e.departementNaissance})`,
    `Nationalité : ${e.nationalite}`,
    `Date et heure d'embauche : ${e.dateEmbauche} à ${e.heureEmbauche}`,
    `Contrat : ${e.typeContrat}${e.dateFinContrat ? ` jusqu'au ${e.dateFinContrat}` : ""}`,
    `Emploi : ${e.poste}`,
  ];
  return lines.join("\n");
}
