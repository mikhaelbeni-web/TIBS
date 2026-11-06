"use client";

import { addDoc, arrayUnion, collection, doc, onSnapshot, setDoc, updateDoc, writeBatch } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, ErrorBox, Select } from "@/components/ui";
import { db } from "@/lib/firebase";
import { formatEuros } from "@/lib/money";
import { rapprocher, type BilanFournisseur, type EtatMois, type TiersSansFournisseur } from "@/lib/rapprochementFournisseurs";
import type { BankTransaction, Invoice, Supplier, WithId } from "@/lib/types";

const DEPUIS = "2026-01";
const fr = (iso: string) => iso.split("-").reverse().join("/");
const parisJour = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const NOMS_MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
const nomMois = (m: string) => `${NOMS_MOIS[Number(m.slice(5)) - 1]}`;

const ETAT: Record<EtatMois, { label: string; classe: string }> = {
  paye: { label: "Payé, retrouvé au relevé", classe: "bg-success-soft text-success" },
  partiel: { label: "Payé en partie", classe: "bg-warning-soft text-warning" },
  a_payer: { label: "À payer (échéance pas passée)", classe: "bg-surface-2 text-muted" },
  non_vu: { label: "Pas retrouvé au relevé", classe: "bg-danger-soft text-danger" },
  sans_banque: { label: "Relevé bancaire absent pour ce mois", classe: "bg-surface-2 text-muted line-through" },
  manquantes: { label: "Payé sans facture : factures manquantes", classe: "bg-danger text-white" },
  rien: { label: "Rien ce mois", classe: "text-muted/50" },
};

/**
 * Factures fournisseurs ↔ relevé bancaire depuis janvier : ce qui est payé, ce qui manque, les remises groupées.
 * Calculé dans le navigateur avec les données déjà chargées par la page Factures (aucune lecture en plus).
 */
export function RapprochementFournisseurs({
  invoices,
  suppliers,
  banque,
  onFournisseur,
}: {
  invoices: WithId<Invoice>[];
  suppliers: WithId<Supplier>[];
  banque: WithId<BankTransaction>[];
  onFournisseur: (s: WithId<Supplier>) => void;
}) {
  const { rid } = useRestaurant();
  const [hors, setHors] = useState<string[]>([]);
  const [erreur, setErreur] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(
    () =>
      onSnapshot(
        doc(db(), "restaurants", rid, "settings", "app"),
        (s) => setHors(((s.get("horsFournisseurs") as string[] | undefined) ?? []).filter((x) => typeof x === "string")),
        () => setHors([]),
      ),
    [rid],
  );
  const r = useMemo(() => rapprocher(suppliers, invoices, banque, { depuis: DEPUIS, aujourdhui: parisJour(), horsFournisseurs: hors }), [suppliers, invoices, banque, hors]);
  const mois = useMemo(() => {
    const out: string[] = [];
    for (let m = r.depuis; m <= r.jusqua; m = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 1)).toISOString().slice(0, 7)) out.push(m);
    return out;
  }, [r.depuis, r.jusqua]);

  const manquants = r.fournisseurs.filter((b) => b.totalSansFacture > 0);
  const prlvSansFiche = r.sansFournisseur.filter((t) => t.type === "prelevement");
  const virSansFiche = r.sansFournisseur.filter((t) => t.type !== "prelevement");
  const nonVus = r.fournisseurs.filter((b) => b.mois.some((l) => l.etat === "non_vu"));
  const autres = r.fournisseurs.filter((b) => !manquants.includes(b) && !nonVus.includes(b) && b.totalFacture > 0);
  const remisesNonExpliquees = r.remises.filter((x) => !x.groupes);

  async function pointer() {
    if (!r.aPointer.length || !confirm(`Marquer payées les ${r.aPointer.length} facture(s) retrouvées au relevé bancaire ?`)) return;
    setBusy(true);
    setErreur(null);
    try {
      for (let i = 0; i < r.aPointer.length; i += 400) {
        const batch = writeBatch(db());
        for (const p of r.aPointer.slice(i, i + 400))
          batch.update(doc(db(), "restaurants", rid, "invoices", p.factureId), { statut: "payee", datePaiement: p.date, paiement: p.mode });
        await batch.commit();
      }
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pasFournisseur(t: TiersSansFournisseur) {
    setErreur(null);
    try {
      await setDoc(doc(db(), "restaurants", rid, "settings", "app"), { horsFournisseurs: arrayUnion(t.tiers) }, { merge: true });
    } catch (e) {
      setErreur((e as Error).message);
    }
  }

  async function rattacher(t: TiersSansFournisseur, supplierId: string) {
    setErreur(null);
    try {
      if (supplierId === "nouveau") {
        const nom = t.tiers.toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
        await addDoc(collection(db(), "restaurants", rid, "suppliers"), {
          nom,
          paiement: t.type === "prelevement" ? "prelevement" : "virement",
          libelleBanque: t.tiers,
          createdAt: Date.now(),
        });
        return;
      }
      const s = suppliers.find((x) => x.id === supplierId);
      if (!s) return;
      const lib = [s.libelleBanque?.trim(), t.tiers].filter(Boolean).join(", ");
      await updateDoc(doc(db(), "restaurants", rid, "suppliers", s.id), { libelleBanque: lib, ...(t.type === "prelevement" ? { paiement: "prelevement" } : {}) });
    } catch (e) {
      setErreur((e as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="space-y-2 text-sm">
        <p>
          Chaque facture est cherchée au centime près sur le relevé : prélèvement, virement, ou remise de virements groupés.
          {r.debutBanque ? (
            <> Relevé bancaire disponible depuis le <strong>{fr(r.debutBanque)}</strong> : avant, impossible de contrôler.</>
          ) : (
            <> <strong>Aucune opération bancaire</strong> pour ce restaurant : connecte la banque et importe le relevé depuis janvier dans Pointage caisse / banque.</>
          )}
        </p>
        {r.debutBanque && r.debutBanque > `${DEPUIS}-01` && (
          <p className="text-warning">
            Pour contrôler janvier à {nomMois(r.debutBanque.slice(0, 7))} : exporte le relevé en CSV sur le site de la banque (du 01/01/2026 au {fr(r.debutBanque)}) et importe-le dans Pointage caisse / banque.
          </p>
        )}
        <ErrorBox message={erreur} />
        {r.aPointer.length > 0 && (
          <Button onClick={pointer} disabled={busy} className="w-full sm:w-auto">
            {busy ? "Enregistrement…" : `Marquer payées les ${r.aPointer.length} facture(s) retrouvées au relevé`}
          </Button>
        )}
      </Card>

      {(manquants.length > 0 || prlvSansFiche.length > 0) && (
        <section>
          <h2 className="font-semibold">Factures manquantes</h2>
          <p className="mb-2 text-sm text-muted">Payé sur le compte, mais aucune facture correspondante dans l&apos;app.</p>
          <ul className="space-y-2">
            {manquants.map((b) => (
              <li key={b.cle}>
                <Card className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <button type="button" className="min-w-0 text-left font-semibold underline-offset-2 hover:underline" onClick={() => b.supplier && onFournisseur(b.supplier)}>
                      {b.nom}
                    </button>
                    <span className="shrink-0 font-semibold tabular-nums text-danger">{formatEuros(b.totalSansFacture)}</span>
                  </div>
                  <ul className="space-y-0.5 text-xs text-muted">
                    {b.paiements
                      .filter((p) => !p.factures.length)
                      .map((p) => (
                        <li key={p.debitId} className="flex justify-between gap-2">
                          <span>{fr(p.date)} · {p.type === "prelevement" ? "prélèvement" : "virement"} sans facture</span>
                          <span className="tabular-nums">{formatEuros(p.montant)}</span>
                        </li>
                      ))}
                  </ul>
                </Card>
              </li>
            ))}
            {prlvSansFiche.map((t) => (
              <li key={t.tiers}>
                <TiersCard t={t} suppliers={suppliers} onRattacher={rattacher} onIgnorer={pasFournisseur} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {nonVus.length > 0 && (
        <section>
          <h2 className="font-semibold">Factures pas retrouvées au relevé</h2>
          <p className="mb-2 text-sm text-muted">Échéance passée, aucun débit au centime : pas encore payées, payées autrement (chèque, carte), ou dans une remise groupée incomplète.</p>
          <ul className="space-y-2">
            {nonVus.map((b) => (
              <li key={b.cle}><BilanCard b={b} mois={mois} onFournisseur={onFournisseur} /></li>
            ))}
          </ul>
        </section>
      )}

      {r.remises.length > 0 && (
        <section>
          <h2 className="font-semibold">Remises de virements groupés</h2>
          <p className="mb-2 text-sm text-muted">
            Le relevé ne donne que le total. Une remise est expliquée quand des fournisseurs du mois précédent la composent au centime.
            {remisesNonExpliquees.length ? ` ${remisesNonExpliquees.length} non expliquée(s) : factures absentes de l'app, ou salaires.` : ""}
          </p>
          <ul className="space-y-2">
            {r.remises.map((x) => (
              <li key={x.debit.id}>
                <Card className="space-y-1 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <span className="font-medium">Remise du {fr(x.debit.date)}</span>
                    <span className="shrink-0 font-semibold tabular-nums">{formatEuros(x.debit.montant)}</span>
                  </div>
                  {x.groupes ? (
                    <ul className="space-y-0.5 text-xs text-muted">
                      {x.groupes.map((g) => (
                        <li key={`${g.cle}${g.mois}`} className="flex justify-between gap-2">
                          <span className="truncate">{g.nom} · factures de {nomMois(g.mois)}</span>
                          <span className="tabular-nums">{formatEuros(g.montant)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Badge tone="orange">Non expliquée</Badge>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        </section>
      )}

      {autres.length > 0 && (
        <section>
          <h2 className="mb-2 font-semibold">Autres fournisseurs</h2>
          <ul className="space-y-2">
            {autres.map((b) => (
              <li key={b.cle}><BilanCard b={b} mois={mois} onFournisseur={onFournisseur} /></li>
            ))}
          </ul>
        </section>
      )}

      {virSansFiche.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer select-none py-2 font-semibold">Virements à classer ({virSansFiche.length})</summary>
          <p className="mb-2 text-muted">Virements à des bénéficiaires qui ne sont pas des fournisseurs connus : rattache-les, ou indique que ce n&apos;est pas un fournisseur.</p>
          <ul className="space-y-2">
            {virSansFiche.map((t) => (
              <li key={t.tiers}><TiersCard t={t} suppliers={suppliers} onRattacher={rattacher} onIgnorer={pasFournisseur} /></li>
            ))}
          </ul>
        </details>
      )}

      <details className="text-xs text-muted">
        <summary className="cursor-pointer select-none py-2">Légende des mois</summary>
        <ul className="space-y-1">
          {(Object.keys(ETAT) as EtatMois[]).filter((e) => e !== "rien").map((e) => (
            <li key={e} className="flex items-center gap-2"><span className={`inline-block h-4 w-8 rounded ${ETAT[e].classe}`} /> {ETAT[e].label}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function BilanCard({ b, mois, onFournisseur }: { b: BilanFournisseur; mois: string[]; onFournisseur: (s: WithId<Supplier>) => void }) {
  const reste = b.mois.filter((l) => l.etat === "non_vu").reduce((s, l) => s + l.facture - l.paye, 0);
  return (
    <Card className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" className="truncate text-left font-semibold underline-offset-2 hover:underline" onClick={() => b.supplier && onFournisseur(b.supplier)}>
            {b.nom}
          </button>
          <div className="text-xs text-muted">
            {b.modeConstate === "prelevement" ? "Prélevé" : b.modeConstate === "virement" ? "Virement" : b.mode === "prelevement" ? "Prélèvement" : "Virement (remise groupée ?)"}
            {" · "}
            {formatEuros(b.totalFacture)} facturés · {formatEuros(b.totalPaye)} retrouvés
          </div>
        </div>
        {reste > 0 && <span className="shrink-0 font-semibold tabular-nums text-danger">{formatEuros(reste)}</span>}
      </div>
      <div className="grid grid-cols-6 gap-1 sm:grid-cols-12">
        {mois.map((m) => {
          const l = b.mois.find((x) => x.mois === m);
          const e = l?.etat ?? "rien";
          return (
            <div key={m} title={`${nomMois(m)} : ${ETAT[e].label}${l?.facture ? ` (${formatEuros(l.facture)})` : ""}`} className={`rounded px-0.5 py-1 text-center text-[11px] leading-tight ${ETAT[e].classe}`}>
              <div>{nomMois(m)}</div>
              <div className="tabular-nums">{l?.nbFactures ? l.nbFactures : "·"}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function TiersCard({
  t,
  suppliers,
  onRattacher,
  onIgnorer,
}: {
  t: TiersSansFournisseur;
  suppliers: WithId<Supplier>[];
  onRattacher: (t: TiersSansFournisseur, supplierId: string) => Promise<void>;
  onIgnorer: (t: TiersSansFournisseur) => Promise<void>;
}) {
  const [choix, setChoix] = useState("");
  return (
    <Card className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{t.tiers}</div>
          <div className="text-xs text-muted">
            {t.nombre} {t.type === "prelevement" ? "prélèvement(s)" : "virement(s)"} du {fr(t.premier)} au {fr(t.dernier)}, aucune fiche fournisseur
          </div>
        </div>
        <span className="shrink-0 font-semibold tabular-nums">{formatEuros(t.total)}</span>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={choix} onChange={(e) => setChoix(e.target.value)} aria-label="Rattacher à un fournisseur">
          <option value="">Rattacher à…</option>
          <option value="nouveau">Nouveau fournisseur « {t.tiers} »</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>{s.nom}</option>
          ))}
        </Select>
        <Button variant="secondary" disabled={!choix} onClick={() => onRattacher(t, choix)}>Rattacher</Button>
        <Button variant="ghost" onClick={() => onIgnorer(t)}>Pas un fournisseur</Button>
      </div>
    </Card>
  );
}
