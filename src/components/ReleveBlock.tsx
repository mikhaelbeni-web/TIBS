"use client";

import { deleteField, doc, updateDoc } from "firebase/firestore";
import { useState } from "react";
import { PdfApercu } from "@/components/PdfApercu";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, ErrorBox } from "@/components/ui";
import { db } from "@/lib/firebase";
import { formatEuros } from "@/lib/money";
import { cleEcart, rapprocher, type EtatLigne, type Releve } from "@/lib/releves";
import type { Invoice, ModePaiement, WithId } from "@/lib/types";

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");

const LIBELLE: Record<EtatLigne["etat"], string> = {
  ok: "OK",
  montant: "Montant différent",
  probable: "Correspondance probable, à confirmer",
  en_attente: "Reçue, à valider dans « À vérifier »",
  non_recue: "Facture non reçue : à demander au fournisseur",
};

/**
 * Contrôle du relevé d'un fournisseur, sous sa carte « Par fournisseur » :
 * chaque ligne du relevé a sa facture, chaque facture de la période est sur le relevé.
 */
export function ReleveBlock({
  releve,
  factures,
  enAttente,
  mode,
  onOpen,
}: {
  releve: WithId<Releve>;
  factures: WithId<Invoice>[];
  enAttente: string[];
  mode: ModePaiement;
  onOpen: (i: WithId<Invoice>) => void;
}) {
  const { rid } = useRestaurant();
  const [error, setError] = useState<string | null>(null);
  const r = rapprocher(releve, factures, enAttente);
  const justifies = releve.justifies ?? {};
  const periode = releve.periodeDebut && releve.periodeFin ? `du ${fr(releve.periodeDebut)} au ${fr(releve.periodeFin)}` : fr(releve.dateReleve);

  async function justifier(cle: string, deja: boolean) {
    setError(null);
    try {
      if (deja) {
        await updateDoc(doc(db(), "restaurants", rid, "releves", releve.id), { [`justifies.${cle}`]: deleteField() });
        return;
      }
      const note = prompt("Pourquoi cet écart est-il justifié ? (ex. facture demandée, avoir à venir)");
      if (note === null) return;
      await updateDoc(doc(db(), "restaurants", rid, "releves", releve.id), { [`justifies.${cle}`]: note.trim().slice(0, 200) || "justifié" });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const etat = !releve.coherent ? (
    <Badge tone="orange">Lecture à vérifier</Badge>
  ) : r.ecarts === 0 ? (
    <Badge tone="green">Tout correspond</Badge>
  ) : (
    <Badge tone="red">{r.ecarts} écart{r.ecarts > 1 ? "s" : ""}</Badge>
  );

  const ligneEcart = (cle: string, titre: string, detail: string, onClick?: () => void) => {
    const deja = Boolean(justifies[cle]);
    return (
      <li key={cle} className="space-y-1 py-2">
        <div className="flex items-start justify-between gap-2">
          <button type="button" className="min-w-0 text-left" onClick={onClick} disabled={!onClick}>
            <div className={`truncate font-medium ${deja ? "text-muted line-through" : ""}`}>{titre}</div>
            <div className="text-xs text-muted">{deja ? `Justifié : ${justifies[cle]}` : detail}</div>
          </button>
          <button type="button" className="shrink-0 rounded-control border border-border px-2 py-1 text-xs" onClick={() => justifier(cle, deja)}>
            {deja ? "Rouvrir" : "Justifier"}
          </button>
        </div>
      </li>
    );
  };

  return (
    <details className="rounded-control border border-border p-3 text-sm">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="font-medium">Relevé</span>
          <span className="text-muted">
            {" "}
            {releve.numero ? `n° ${releve.numero} ` : ""}
            {periode}
          </span>
        </span>
        {etat}
      </summary>

      <div className="mt-3 space-y-3">
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1">
          <dt className="text-muted">Total du relevé</dt>
          <dd className="text-right tabular-nums">{formatEuros(r.totalReleve)}</dd>
          <dt className="text-muted">Factures chez nous</dt>
          <dd className="text-right tabular-nums">
            {r.lignes.filter((l) => l.etat === "ok").length}/{releve.lignes.length} retrouvées
          </dd>
          {releve.soldeAnterieur ? (
            <>
              <dt className="text-muted">Solde antérieur indiqué</dt>
              <dd className="text-right tabular-nums">{formatEuros(releve.soldeAnterieur)}</dd>
            </>
          ) : null}
          {releve.netAPayer !== undefined && (
            <>
              <dt className="text-muted">Net à payer (relevé)</dt>
              <dd className="text-right tabular-nums">{formatEuros(releve.netAPayer)}</dd>
            </>
          )}
        </dl>

        {!releve.coherent && (
          <p className="rounded-control bg-warning-soft p-2">
            La somme des lignes lues ne correspond pas au total du relevé : vérifie avec le PDF. Aucun montant n&apos;est proposé.
          </p>
        )}
        {releve.coherent && mode === "virement" && (
          <p className="rounded-control bg-surface-2 p-2">
            Montant à virer conseillé : <strong className="tabular-nums">{formatEuros(r.aPayer)}</strong>{" "}
            {r.base === "releve" ? "(net du relevé, tout est justifié)." : "(seulement les factures que tu as reçues : jamais une ligne sans facture)."}
          </p>
        )}

        {(r.ecarts > 0 || Object.keys(justifies).length > 0) && (
          <ul className="divide-y divide-border">
            {r.lignes
              .filter((l) => l.etat !== "ok")
              .map((l) =>
                ligneEcart(
                  cleEcart("ligne", l.ligne.numero),
                  `N° ${l.ligne.numero} · ${formatEuros(l.ligne.montantTTC)}`,
                  l.etat === "montant"
                    ? `Montant différent : ${formatEuros(l.facture.montantTTC)} chez nous / ${formatEuros(l.ligne.montantTTC)} sur le relevé`
                    : l.etat === "probable"
                      ? `${LIBELLE.probable} (facture n° ${l.facture.numero || "?"} du ${fr(l.facture.dateFacture)})`
                      : LIBELLE[l.etat],
                  "facture" in l ? () => onOpen(l.facture) : undefined,
                ),
              )}
            {r.absentes.map((f) =>
              ligneEcart(cleEcart("facture", f.numero || f.id), `N° ${f.numero || "—"} · ${formatEuros(f.montantTTC)}`, "Facture absente du relevé", () => onOpen(f)),
            )}
          </ul>
        )}
        {r.lignes.some((l) => l.etat === "ok" && l.horsPeriode) && <p className="text-xs text-muted">Certaines factures du relevé sont datées d&apos;un autre mois (hors période) : normal en fin de mois.</p>}
        <ErrorBox message={error} />
        {releve.source.attachment && <PdfApercu requete={`c=releve&i=${encodeURIComponent(releve.id)}`} nom="le relevé" />}
      </div>
    </details>
  );
}
