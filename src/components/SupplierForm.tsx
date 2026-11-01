"use client";

import { addDoc, collection, deleteDoc, deleteField, doc, updateDoc } from "firebase/firestore";
import { useState, type FormEvent } from "react";
import { Button, ErrorBox, Field, Input, Select } from "@/components/ui";
import { useRestaurant } from "@/components/RestaurantProvider";
import { db } from "@/lib/firebase";
import type { ModePaiement, Supplier, WithId } from "@/lib/types";

/** Fiche fournisseur : coordonnées et mode de paiement (virement à faire ou prélèvement à contrôler). */
export function SupplierForm({ initial, onDone }: { initial: WithId<Supplier> | null; onDone: () => void }) {
  const { rid } = useRestaurant();
  const [f, setF] = useState({
    nom: initial?.nom ?? "",
    siret: initial?.siret ?? "",
    email: initial?.email ?? "",
    categorie: initial?.categorie ?? "",
    paiement: initial?.paiement ?? ("virement" as ModePaiement),
    iban: initial?.iban ?? "",
    libelleBanque: initial?.libelleBanque ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const iban = f.iban.replace(/\s/g, "").toUpperCase();
    if (iban && !/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return setError("IBAN invalide (ex. FR76 3000 …).");
    const data = {
      nom: f.nom.trim(),
      siret: f.siret.replace(/\s/g, ""),
      email: f.email.trim(),
      categorie: f.categorie.trim(),
      paiement: f.paiement,
      iban,
      libelleBanque: f.libelleBanque.trim(),
    };
    try {
      if (initial) await updateDoc(doc(db(), "restaurants", rid, "suppliers", initial.id), { ...data, ...(iban ? {} : { iban: deleteField() }) });
      else await addDoc(collection(db(), "restaurants", rid, "suppliers"), { ...data, createdAt: Date.now() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function remove() {
    if (!initial || !confirm(`Supprimer ${initial.nom} ? Ses factures restent enregistrées.`)) return;
    await deleteDoc(doc(db(), "restaurants", rid, "suppliers", initial.id));
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Nom"><Input required value={f.nom} onChange={(e) => setF({ ...f, nom: e.target.value })} /></Field>
      <Field label="Mode de paiement">
        <Select value={f.paiement} onChange={(e) => setF({ ...f, paiement: e.target.value as ModePaiement })}>
          <option value="virement">Virement : je paie</option>
          <option value="prelevement">Prélèvement : il se sert, je contrôle</option>
        </Select>
      </Field>
      {f.paiement === "virement" ? (
        <Field label="IBAN" hint="Pour copier-coller au moment du virement.">
          <Input value={f.iban} autoCapitalize="characters" onChange={(e) => setF({ ...f, iban: e.target.value })} placeholder="FR76 …" />
        </Field>
      ) : (
        <Field label="Libellé sur le relevé bancaire" hint="Mots du prélèvement sur le relevé, séparés par des virgules. Vide = nom du fournisseur.">
          <Input value={f.libelleBanque} onChange={(e) => setF({ ...f, libelleBanque: e.target.value })} placeholder="ex. METRO, MAKRO" />
        </Field>
      )}
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
