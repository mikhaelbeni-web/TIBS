/** Mail texte UTF-8 au format RFC 2822, encodé en base64url pour l'API Gmail (messages.send). */
export interface MailTexte {
  de: string;
  a: string;
  objet: string;
  corps: string;
  /** Message-ID du mail auquel on répond (pour rester dans le même fil chez le fournisseur). */
  enReponseA?: string;
}

const enTete = (s: string) => s.replace(/[\r\n]+/g, " ").trim();
/** Objet encodé (RFC 2047) dès qu'il y a un caractère non ASCII. */
export const encoderObjet = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

export function construireMail(m: MailTexte): string {
  const corps = Buffer.from(m.corps.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
  const lignes = [
    `From: ${enTete(m.de)}`,
    `To: ${enTete(m.a)}`,
    `Subject: ${encoderObjet(enTete(m.objet))}`,
    ...(m.enReponseA ? [`In-Reply-To: ${enTete(m.enReponseA)}`, `References: ${enTete(m.enReponseA)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    corps,
  ];
  return Buffer.from(lignes.join("\r\n"), "utf8").toString("base64url");
}
