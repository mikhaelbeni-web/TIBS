"use client";

import { addDoc, collection, deleteDoc, doc, updateDoc } from "firebase/firestore";
import { useCallback, useState, type FormEvent } from "react";
import { Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Sheet } from "@/components/ui";
import { db } from "@/lib/firebase";
import type { Supplier, WithId } from "@/lib/types";
import { useCollection } from "@/lib/useCollection";

export default function FournisseursPage() {
  const { items, loading, error } = useCollection<Supplier>("suppliers", "nom");
  const [editing, setEditing] = useState<WithId<Supplier> | "new" | null>(null);
  const [q, setQ] = useState("");
  const close = useCallback(() => setEditing(null), []);
  const shown = items.filter((s) => s.nom.toLowerCase().includes(q.toLowerCase()));

  return (
    <div>
      <PageHeader title="Fournisseurs" action={<Button onClick={() => setEditing("new")}>+ Ajouter</Button>} />
      <Input placeholder="Rechercher…" value={q} onChange={(e) => setQ(e.target.value)} className="mb-4" />
      <ErrorBox message={error} />
      {loading ? (
        <p className="text-neutral-500">Chargement…</p>
      ) : shown.length === 0 ? (
        <Empty>Aucun fournisseur.</Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((s) => (
            <li key={s.id}>
              <button className="w-full text-left" onClick={() => setEditing(s)}>
                <Card className="hover:border-black">
                  <div className="font-semibold">{s.nom}</div>
                  <div className="text-sm text-neutral-600">{[s.categorie, s.email].filter(Boolean).join(" · ") || "—"}</div>
                  {s.siret && <div className="text-xs text-neutral-500">SIRET {s.siret}</div>}
                </Card>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={editing !== null} onClose={close} title={editing === "new" ? "Nouveau fournisseur" : "Modifier le fournisseur"}>
        {editing !== null && <SupplierForm initial={editing === "new" ? null : editing} onDone={close} />}
      </Sheet>
    </div>
  );
}

function SupplierForm({ initial, onDone }: { initial: WithId<Supplier> | null; onDone: () => void }) {
  const [f, setF] = useState({
    nom: initial?.nom ?? "",
    siret: initial?.siret ?? "",
    email: initial?.email ?? "",
    categorie: initial?.categorie ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const data = { ...f, nom: f.nom.trim(), siret: f.siret.replace(/\s/g, "") };
    try {
      if (initial) await updateDoc(doc(db(), "suppliers", initial.id), data);
      else await addDoc(collection(db(), "suppliers"), { ...data, createdAt: Date.now() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!initial || !confirm(`Supprimer ${initial.nom} ? Ses factures restent enregistrées.`)) return;
    await deleteDoc(doc(db(), "suppliers", initial.id));
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Nom"><Input required value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} /></Field>
      <Field label="Catégorie" hint="Boissons, viande, emballages…"><Input value={f.categorie} onChange={(e) => setF({ ...f, categorie: e.target.value })} /></Field>
      <Field label="E-mail"><Input type="email" inputMode="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label="SIRET"><Input inputMode="numeric" value={f.siret} onChange={(e) => setF({ ...f, siret: e.target.value })} /></Field>
      <ErrorBox message={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        {initial ? <Button type="button" variant="danger" onClick={remove}>Supprimer</Button> : <span />}
        <Button type="submit">Enregistrer</Button>
      </div>
    </form>
  );
}
