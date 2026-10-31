"use client";

import { addDoc, collection, deleteDoc, doc, updateDoc } from "firebase/firestore";
import Link from "next/link";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Sheet } from "@/components/ui";
import { db } from "@/lib/firebase";
import { formatEuros, toCents } from "@/lib/money";
import type { Invoice, StatutFacture, Supplier, WithId } from "@/lib/types";
import { useCollection } from "@/lib/useCollection";

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
const thisMonth = () => new Date().toISOString().slice(0, 7);
const STATUT: Record<StatutFacture, { label: string; tone: "orange" | "green" | "red" }> = {
  a_payer: { label: "À payer", tone: "orange" },
  payee: { label: "Payée", tone: "green" },
  litige: { label: "Litige", tone: "red" },
};

export default function FacturesPage() {
  const { items, loading, error } = useCollection<Invoice>("invoices", "dateFacture", true);
  const suppliers = useCollection<Supplier>("suppliers", "nom");
  const [mois, setMois] = useState(thisMonth());
  const [editing, setEditing] = useState<WithId<Invoice> | "new" | null>(null);
  const close = useCallback(() => setEditing(null), []);

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
  const bySupplier = useMemo(() => {
    const m = new Map<string, number>();
    month.forEach((i) => m.set(i.supplierNom, (m.get(i.supplierNom) ?? 0) + i.montantTTC));
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [month]);

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
    await updateDoc(doc(db(), "invoices", i.id), { statut: "payee", datePaiement: new Date().toISOString().slice(0, 10) });
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
        <Card><div className="text-xs text-muted">Total HT</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totals.ht)}</div></Card>
        <Card><div className="text-xs text-muted">TVA</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totals.tva)}</div></Card>
        <Card><div className="text-xs text-muted">Total TTC</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totals.ttc)}</div></Card>
        <Card><div className="text-xs text-muted">Reste à payer</div><div className="text-lg font-semibold text-warning">{formatEuros(totals.due)}</div></Card>
      </div>

      {bySupplier.length > 1 && (
        <Card className="mb-4">
          <div className="mb-2 text-sm font-medium">Par fournisseur</div>
          <ul className="space-y-1 text-sm">
            {bySupplier.map(([nom, ttc]) => (
              <li key={nom} className="flex justify-between gap-2"><span className="truncate">{nom}</span><span className="tabular-nums">{formatEuros(ttc)}</span></li>
            ))}
          </ul>
        </Card>
      )}

      <ErrorBox message={error} />
      {loading ? (
        <p className="text-muted">Chargement…</p>
      ) : month.length === 0 ? (
        <Empty>Aucune facture pour ce mois.</Empty>
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

      <Sheet open={editing !== null} onClose={close} title={editing === "new" ? "Nouvelle facture" : "Modifier la facture"}>
        {editing !== null && <InvoiceForm initial={editing === "new" ? null : editing} suppliers={suppliers.items} onDone={close} />}
      </Sheet>
    </div>
  );
}

const euros = (c?: number) => (c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));

function InvoiceForm({ initial, suppliers, onDone }: { initial: WithId<Invoice> | null; suppliers: WithId<Supplier>[]; onDone: () => void }) {
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
      if (initial) await updateDoc(doc(db(), "invoices", initial.id), data);
      else await addDoc(collection(db(), "invoices"), { ...data, createdAt: new Date().getTime() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!initial || !confirm("Supprimer cette facture ?")) return;
    await deleteDoc(doc(db(), "invoices", initial.id));
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Fournisseur">
        <Select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}>
          {suppliers.map((s) => <option key={s.id} value={s.id}>{s.nom}</option>)}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
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
      <div className="grid grid-cols-3 gap-2">
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
