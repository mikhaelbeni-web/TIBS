"use client";

import { useCallback, useState } from "react";
import { SupplierForm } from "@/components/SupplierForm";
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Sheet } from "@/components/ui";
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
        <p className="text-muted">Chargement…</p>
      ) : shown.length === 0 ? (
        <Empty>Aucun fournisseur.</Empty>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shown.map((s) => (
            <li key={s.id}>
              <button className="w-full text-left" onClick={() => setEditing(s)}>
                <Card className="hover:border-ink">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{s.nom}</span>
                    <Badge tone={s.paiement === "prelevement" ? "info" : "neutral"}>{s.paiement === "prelevement" ? "Prélèvement" : "Virement"}</Badge>
                  </div>
                  <div className="text-sm text-muted">{[s.categorie, s.email].filter(Boolean).join(" · ") || "—"}</div>
                  {s.siret && <div className="text-xs text-muted">SIRET {s.siret}</div>}
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
