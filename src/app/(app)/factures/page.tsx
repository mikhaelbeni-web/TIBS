"use client";

import { addDoc, collection, deleteDoc, doc, updateDoc, writeBatch } from "firebase/firestore";
import Link from "next/link";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Sheet } from "@/components/ui";
import { useRestaurant } from "@/components/RestaurantProvider";
import { db } from "@/lib/firebase";
import { formatEuros, toCents } from "@/lib/money";
import { controlerPrelevement, echeanceVirement, grouperParFournisseur, referenceVirement, type GroupeFournisseur } from "@/lib/paiements";
import type { BankTransaction, Invoice, ModePaiement, StatutFacture, Supplier, WithId } from "@/lib/types";
import { SupplierForm } from "@/components/SupplierForm";
import { useCollection } from "@/lib/useCollection";

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
const thisMonth = () => new Date().toISOString().slice(0, 7);
const STATUT: Record<StatutFacture, { label: string; tone: "orange" | "green" | "red" }> = {
  a_payer: { label: "À payer", tone: "orange" },
  payee: { label: "Payée", tone: "green" },
  litige: { label: "Litige", tone: "red" },
};

export default function FacturesPage() {
  const { rid } = useRestaurant();
  const { items, loading, error } = useCollection<Invoice>("invoices", "dateFacture", true);
  const suppliers = useCollection<Supplier>("suppliers", "nom");
  const [mois, setMois] = useState(thisMonth());
  const banque = useCollection<BankTransaction>("bankTransactions", "date", true);
  const [vue, setVue] = useState<"paiements" | "liste">("paiements");
  const [editing, setEditing] = useState<WithId<Invoice> | "new" | null>(null);
  const [fournisseur, setFournisseur] = useState<WithId<Supplier> | null>(null);
  const close = useCallback(() => setEditing(null), []);
  const closeFournisseur = useCallback(() => setFournisseur(null), []);

  const month = useMemo(() => items.filter((i) => i.mois === mois), [items, mois]);
  const totals = useMemo(
    () =>
      month.reduce(
        (t, i) => ({
          ht: t.ht + i.montantHT,
          tva: t.tva + i.montantTVA,
          ttc: t.ttc + i.montantTTC,
          due: t.due + (i.statut === "payee" ? 0 : i.montantTTC),
        }),
        { ht: 0, tva: 0, ttc: 0, due: 0 },
      ),
    [month],
  );
  const groupes = useMemo(() => grouperParFournisseur(month, suppliers.items), [month, suppliers.items]);
  const aVirer = groupes.filter((g) => g.mode === "virement");
  const prelevements = groupes.filter((g) => g.mode === "prelevement");
  const somme = (gs: GroupeFournisseur[]) => gs.reduce((t, g) => t + g.reste, 0);

  /** Marque payées toutes les factures « à payer » du groupe (un seul virement, ou prélèvement contrôlé). */
  async function regler(g: GroupeFournisseur, mode: ModePaiement) {
    const batch = writeBatch(db());
    const jour = new Date().toISOString().slice(0, 10);
    g.factures.filter((f) => f.statut === "a_payer").forEach((f) => batch.update(doc(db(), "restaurants", rid, "invoices", f.id), { statut: "payee", datePaiement: jour, paiement: mode }));
    await batch.commit();
  }

  function exportCsv() {
    const head = "Fournisseur;N° facture;Date;Échéance;HT;TVA;TTC;Statut;Payée le";
    const num = (c: number) => (c / 100).toFixed(2).replace(".", ",");
    const lines = month.map((i) =>
      [i.supplierNom, i.numero, fr(i.dateFacture), fr(i.dateEcheance), num(i.montantHT), num(i.montantTVA), num(i.montantTTC), STATUT[i.statut].label, fr(i.datePaiement)].join(";"),
    );
    const blob = new Blob(["﻿" + [head, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `factures-${mois}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function markPaid(i: WithId<Invoice>) {
    await updateDoc(doc(db(), "restaurants", rid, "invoices", i.id), { statut: "payee", datePaiement: new Date().toISOString().slice(0, 10) });
  }

  return (
    <div>
      <PageHeader
        title="Factures fournisseurs"
        action={
          <>
            <Link href="/fournisseurs" className="inline-flex min-h-12 items-center rounded-control border border-border bg-surface px-4 text-sm font-medium md:hidden">
              Fournisseurs
            </Link>
            <Button variant="secondary" onClick={exportCsv} disabled={!month.length}>Export comptable</Button>
            <Button onClick={() => setEditing("new")} disabled={!suppliers.items.length}>+ Facture</Button>
          </>
        }
      />
      {!suppliers.loading && !suppliers.items.length && (
        <p className="mb-4 text-sm text-muted">
          Commencez par <Link className="underline" href="/fournisseurs">ajouter un fournisseur</Link>.
        </p>
      )}
      <Field label="Mois"><Input type="month" value={mois} onChange={(e) => setMois(e.target.value || thisMonth())} className="sm:w-56" /></Field>

      <div className="my-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><div className="text-xs text-muted">À virer</div><div className="text-lg font-semibold tabular-nums text-warning">{formatEuros(somme(aVirer))}</div></Card>
        <Card><div className="text-xs text-muted">Prélèvements à contrôler</div><div className="text-lg font-semibold tabular-nums">{formatEuros(somme(prelevements))}</div></Card>
        <Card><div className="text-xs text-muted">Total TTC</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totals.ttc)}</div></Card>
        <Card><div className="text-xs text-muted">dont TVA</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totals.tva)}</div></Card>
      </div>

      <div className="mb-4 grid grid-cols-2 rounded-control border border-border bg-surface p-1 text-sm font-medium sm:inline-grid sm:w-96" role="tablist">
        {(["paiements", "liste"] as const).map((v) => (
          <button key={v} role="tab" aria-selected={vue === v} onClick={() => setVue(v)} className={`min-h-11 rounded-[10px] ${vue === v ? "bg-bar text-white" : "text-muted"}`}>
            {v === "paiements" ? "Par fournisseur" : "Toutes les factures"}
          </button>
        ))}
      </div>

      <ErrorBox message={error} />
      {loading ? (
        <p className="text-muted">Chargement…</p>
      ) : month.length === 0 ? (
        <Empty>Aucune facture pour ce mois.</Empty>
      ) : vue === "paiements" ? (
        <div className="space-y-6">
          {aVirer.length > 0 && (
            <section>
              <h2 className="font-semibold">Virements à faire</h2>
              <p className={`mb-2 text-sm ${somme(aVirer) > 0 && new Date().toISOString().slice(0, 10) > echeanceVirement(mois) ? "font-medium text-danger" : "text-muted"}`}>
                À payer le {fr(echeanceVirement(mois))}
                {somme(aVirer) > 0 && new Date().toISOString().slice(0, 10) > echeanceVirement(mois) ? " : en retard" : ""}.
              </p>
              <ul className="space-y-2">
                {aVirer.map((g) => <li key={g.cle}><GroupeCard g={g} mois={mois} onOpen={setEditing} onFournisseur={setFournisseur} onRegler={regler} /></li>)}
              </ul>
            </section>
          )}
          {prelevements.length > 0 && (
            <section>
              <h2 className="mb-1 font-semibold">Prélèvements à contrôler</h2>
              <p className="mb-2 text-sm text-muted">Comparés aux débits du relevé bancaire importé dans Caisse (du 1er du mois à la fin du mois suivant).</p>
              <ul className="space-y-2">
                {prelevements.map((g) => (
                  <li key={g.cle}><GroupeCard g={g} mois={mois} banque={banque.items} onOpen={setEditing} onFournisseur={setFournisseur} onRegler={regler} /></li>
                ))}
              </ul>
            </section>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {month.map((i) => (
            <li key={i.id}>
              <Card className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(i)}>
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{i.supplierNom}</span>
                    <Badge tone={STATUT[i.statut].tone}>{STATUT[i.statut].label}</Badge>
                  </div>
                  <div className="text-sm text-muted">
                    N° {i.numero} · {fr(i.dateFacture)}{i.dateEcheance ? ` · échéance ${fr(i.dateEcheance)}` : ""}
                  </div>
                </button>
                <div className="flex items-center justify-between gap-3 sm:justify-end">
                  <span className="text-lg font-semibold tabular-nums">{formatEuros(i.montantTTC)}</span>
                  {i.statut !== "payee" && <Button variant="secondary" onClick={() => markPaid(i)}>Payée</Button>}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Sheet open={fournisseur !== null} onClose={closeFournisseur} title="Fournisseur">
        {fournisseur && <SupplierForm initial={fournisseur} onDone={closeFournisseur} />}
      </Sheet>
      <Sheet open={editing !== null} onClose={close} title={editing === "new" ? "Nouvelle facture" : "Modifier la facture"}>
        {editing !== null && <InvoiceForm initial={editing === "new" ? null : editing} suppliers={suppliers.items} onDone={close} />}
      </Sheet>
    </div>
  );
}

function Copier({ texte, label }: { texte: string; label: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      className="shrink-0 rounded-control border border-border px-3 py-2 text-xs font-medium"
      onClick={async () => {
        await navigator.clipboard?.writeText(texte);
        setOk(true);
        setTimeout(() => setOk(false), 1500);
      }}
    >
      {ok ? "Copié" : label}
    </button>
  );
}

function GroupeCard({
  g,
  mois,
  banque,
  onOpen,
  onFournisseur,
  onRegler,
}: {
  g: GroupeFournisseur;
  mois: string;
  banque?: WithId<BankTransaction>[];
  onOpen: (i: WithId<Invoice>) => void;
  onFournisseur: (s: WithId<Supplier>) => void;
  onRegler: (g: GroupeFournisseur, mode: ModePaiement) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const aPayer = g.factures.filter((f) => f.statut === "a_payer").length;
  const fini = aPayer === 0;
  const controle = banque ? controlerPrelevement(g, mois, banque) : null;
  const reference = referenceVirement(mois, g.factures);

  async function regler() {
    const msg =
      g.mode === "virement"
        ? `Marquer ${aPayer} facture(s) de ${g.nom} comme payée(s) par un virement de ${formatEuros(g.reste)} ?`
        : `Marquer le prélèvement de ${g.nom} (${formatEuros(g.reste)}) comme contrôlé ?`;
    if (!confirm(msg)) return;
    setBusy(true);
    setError(null);
    try {
      await onRegler(g, g.mode);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-semibold">{g.nom}</div>
          <div className="text-sm text-muted">
            {g.factures.length} facture{g.factures.length > 1 ? "s" : ""}
            {g.litiges ? ` · ${g.litiges} en litige` : ""}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-semibold tabular-nums">{formatEuros(fini ? g.total : g.reste)}</div>
          {fini ? (
            <Badge tone="green">{g.mode === "virement" ? "Payé" : "Contrôlé"}</Badge>
          ) : controle ? (
            <Badge tone={controle.etat === "ok" ? "green" : controle.etat === "ecart" ? "red" : "orange"}>
              {controle.etat === "ok" ? "Montant OK" : controle.etat === "ecart" ? "Écart" : "Pas encore vu"}
            </Badge>
          ) : (
            <Badge tone="orange">À virer</Badge>
          )}
        </div>
      </div>

      {!fini && g.mode === "virement" && (
        <div className="space-y-2 rounded-control bg-surface-2 p-3 text-sm">
          {g.supplier?.iban ? (
            <div className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate font-mono text-xs">{g.supplier.iban.replace(/(.{4})/g, "$1 ").trim()}</span>
              <Copier texte={g.supplier.iban} label="Copier l'IBAN" />
            </div>
          ) : (
            g.supplier && (
              <button type="button" className="text-left underline" onClick={() => onFournisseur(g.supplier!)}>
                Ajouter l&apos;IBAN du fournisseur
              </button>
            )
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="min-w-0 truncate text-xs text-muted">{reference}</span>
            <Copier texte={reference} label="Copier la référence" />
          </div>
        </div>
      )}

      {!fini && controle && (
        <div className="rounded-control bg-surface-2 p-3 text-sm">
          {controle.etat === "absent" ? (
            <p>
              Aucun prélèvement trouvé dans le relevé. Importe le relevé dans Caisse, ou règle le libellé bancaire du fournisseur
              {g.supplier && (
                <>
                  {" "}
                  (<button type="button" className="underline" onClick={() => onFournisseur(g.supplier!)}>modifier</button>)
                </>
              )}
              .
            </p>
          ) : (
            <>
              <p>
                Prélevé : <strong className="tabular-nums">{formatEuros(controle.preleve)}</strong> pour {formatEuros(g.total)} de factures
                {controle.etat === "ecart" ? ` (écart ${controle.ecart > 0 ? "+" : ""}${formatEuros(controle.ecart)})` : ""}.
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-muted">
                {controle.lignes.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2">
                    <span className="truncate">{fr(l.date)} · {l.libelle}</span>
                    <span className="shrink-0 tabular-nums">{formatEuros(-l.montant)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer select-none py-1 text-muted">Voir les factures</summary>
        <ul className="mt-1 divide-y divide-border">
          {g.factures.map((f) => (
            <li key={f.id}>
              <button className="flex min-h-11 w-full items-center justify-between gap-2 text-left" onClick={() => onOpen(f)}>
                <span className="min-w-0 truncate">
                  {fr(f.dateFacture)} · N° {f.numero || "—"}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="tabular-nums">{formatEuros(f.montantTTC)}</span>
                  {f.statut !== "a_payer" && <Badge tone={STATUT[f.statut].tone}>{STATUT[f.statut].label}</Badge>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </details>

      <ErrorBox message={error} />
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {g.supplier && (
          <Button variant="ghost" onClick={() => onFournisseur(g.supplier!)}>
            {g.mode === "virement" ? "Passer en prélèvement…" : "Fiche fournisseur"}
          </Button>
        )}
        {!fini && (
          <Button variant={g.mode === "virement" ? "primary" : "secondary"} disabled={busy} onClick={regler}>
            {g.mode === "virement" ? `Virement fait (${formatEuros(g.reste)})` : "Prélèvement contrôlé"}
          </Button>
        )}
      </div>
    </Card>
  );
}

const euros = (c?: number) => (c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));

function InvoiceForm({ initial, suppliers, onDone }: { initial: WithId<Invoice> | null; suppliers: WithId<Supplier>[]; onDone: () => void }) {
  const { rid } = useRestaurant();
  const [f, setF] = useState({
    supplierId: initial?.supplierId ?? suppliers[0]?.id ?? "",
    numero: initial?.numero ?? "",
    dateFacture: initial?.dateFacture ?? new Date().toISOString().slice(0, 10),
    dateEcheance: initial?.dateEcheance ?? "",
    ht: euros(initial?.montantHT),
    tva: euros(initial?.montantTVA),
    ttc: euros(initial?.montantTTC),
    statut: initial?.statut ?? ("a_payer" as StatutFacture),
    note: initial?.note ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  // Saisie rapide : HT + TVA => TTC calculé ; ou TTC seul.
  const ht = toCents(f.ht);
  const tva = toCents(f.tva);
  const ttc = toCents(f.ttc) ?? (ht !== null ? ht + (tva ?? 0) : null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (ttc === null) return setError("Indiquez au moins le montant TTC.");
    if (ht !== null && tva !== null && Math.abs(ht + tva - ttc) > 1) return setError("HT + TVA ne correspond pas au TTC.");
    const supplier = suppliers.find((s) => s.id === f.supplierId);
    if (!supplier) return setError("Choisissez un fournisseur.");
    const data: Omit<Invoice, "createdAt"> = {
      supplierId: supplier.id,
      supplierNom: supplier.nom,
      numero: f.numero.trim(),
      dateFacture: f.dateFacture,
      mois: f.dateFacture.slice(0, 7),
      montantHT: ht ?? ttc - (tva ?? 0),
      montantTVA: tva ?? (ht !== null ? ttc - ht : 0),
      montantTTC: ttc,
      statut: f.statut,
      ...(f.dateEcheance ? { dateEcheance: f.dateEcheance } : {}),
      ...(f.note ? { note: f.note } : {}),
      ...(f.statut === "payee" ? { datePaiement: initial?.datePaiement ?? new Date().toISOString().slice(0, 10) } : {}),
    };
    try {
      if (initial) await updateDoc(doc(db(), "restaurants", rid, "invoices", initial.id), data);
      else await addDoc(collection(db(), "restaurants", rid, "invoices"), { ...data, createdAt: new Date().getTime() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!initial || !confirm("Supprimer cette facture ?")) return;
    await deleteDoc(doc(db(), "restaurants", rid, "invoices", initial.id));
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Fournisseur">
        <Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-2 items-end gap-3">
        <Field label="N° de facture"><Input required value={f.numero} onChange={(e) => setF({ ...f, numero: e.target.value })} /></Field>
        <Field label="Statut">
          <Select value={f.statut} onChange={(e) => setF({ ...f, statut: e.target.value as StatutFacture })}>
            <option value="a_payer">À payer</option>
            <option value="payee">Payée</option>
            <option value="litige">Litige</option>
          </Select>
        </Field>
        <Field label="Date"><Input type="date" required value={f.dateFacture} onChange={(e) => setF({ ...f, dateFacture: e.target.value })} /></Field>
        <Field label="Échéance"><Input type="date" value={f.dateEcheance} onChange={(e) => setF({ ...f, dateEcheance: e.target.value })} /></Field>
      </div>
      <div className="grid grid-cols-3 items-end gap-2">
        <Field label="HT €"><Input inputMode="decimal" value={f.ht} onChange={(e) => setF({ ...f, ht: e.target.value })} /></Field>
        <Field label="TVA €"><Input inputMode="decimal" value={f.tva} onChange={(e) => setF({ ...f, tva: e.target.value })} /></Field>
        <Field label="TTC €"><Input inputMode="decimal" placeholder={ttc !== null ? euros(ttc) : ""} value={f.ttc} onChange={(e) => setF({ ...f, ttc: e.target.value })} /></Field>
      </div>
      <Field label="Note"><Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      <ErrorBox message={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        {initial ? <Button type="button" variant="danger" onClick={remove}>Supprimer</Button> : <span />}
        <Button type="submit">Enregistrer</Button>
      </div>
    </form>
  );
}
