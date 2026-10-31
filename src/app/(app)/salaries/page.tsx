"use client";

import { addDoc, collection, deleteDoc, doc, updateDoc, writeBatch } from "firebase/firestore";
import { useCallback, useMemo, useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Sheet } from "@/components/ui";
import { checkDpae, dpaeSheet } from "@/lib/dpae";
import { db } from "@/lib/firebase";
import { readSpreadsheet, rowToEmployee, type EmployeeDraft } from "@/lib/importer";
import type { Employee, TypeContrat, WithId } from "@/lib/types";
import { useCollection } from "@/lib/useCollection";

const EMPTY: EmployeeDraft = {
  nom: "",
  prenom: "",
  sexe: "M",
  nir: "",
  dateNaissance: "",
  lieuNaissance: "",
  departementNaissance: "",
  nationalite: "Française",
  dateEmbauche: "",
  heureEmbauche: "09:00",
  typeContrat: "CDI",
  poste: "",
};

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");

/** Firestore refuse les champs undefined. */
function clean<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== "")) as T;
}

export default function SalariesPage() {
  const { items, loading, error } = useCollection<Employee>("employees", "dateEmbauche", true);
  const [editing, setEditing] = useState<WithId<Employee> | "new" | null>(null);
  const [importRows, setImportRows] = useState<EmployeeDraft[] | null>(null);
  const [declaring, setDeclaring] = useState<WithId<Employee> | null>(null);
  const [opError, setOpError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"todo" | "all">("todo");
  const fileRef = useRef<HTMLInputElement>(null);

  const shown = useMemo(() => (filter === "todo" ? items.filter((e) => e.dpaeStatut !== "declaree") : items), [items, filter]);
  const close = useCallback(() => setEditing(null), []);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setOpError(null);
    try {
      const rows = (await readSpreadsheet(f)).map(rowToEmployee).filter((r) => r.nom || r.prenom);
      if (!rows.length) throw new Error("Aucune ligne reconnue. Vérifiez les en-têtes (voir le modèle).");
      setImportRows(rows);
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function confirmImport() {
    if (!importRows) return;
    const batch = writeBatch(db());
    for (const r of importRows) {
      batch.set(doc(collection(db(), "employees")), clean({ ...r, dpaeStatut: "a_declarer", createdAt: Date.now() }));
    }
    try {
      await batch.commit();
      setImportRows(null);
    } catch (e) {
      setOpError((e as Error).message);
    }
  }

  async function copySheet(e: Employee) {
    try {
      await navigator.clipboard.writeText(dpaeSheet(e));
      alert("Fiche DPAE copiée. Collez-la à côté du formulaire DPAE en ligne.");
    } catch {
      alert(dpaeSheet(e));
    }
  }

  return (
    <div>
      <PageHeader
        title="Équipe et DPAE"
        action={
          <>
            <Button variant="secondary" onClick={() => fileRef.current?.click()}>Importer Excel</Button>
            <Button onClick={() => setEditing("new")}>+ Ajouter</Button>
          </>
        }
      />
      <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />

      <p className="mb-4 text-sm text-muted">
        La DPAE se fait à chaque embauche, au plus tard juste avant la prise de poste, sur{" "}
        <a className="underline" href="https://www.net-entreprises.fr" target="_blank" rel="noreferrer">net-entreprises.fr</a>.{" "}
        <a className="underline" href="/modele-salaries.csv" download>Télécharger le modèle Excel/CSV</a>.
      </p>

      <div className="mb-4 flex gap-2">
        <Button variant={filter === "todo" ? "primary" : "secondary"} onClick={() => setFilter("todo")}>À déclarer</Button>
        <Button variant={filter === "all" ? "primary" : "secondary"} onClick={() => setFilter("all")}>Tous ({items.length})</Button>
      </div>

      <ErrorBox message={error || opError} />
      {loading ? (
        <p className="text-muted">Chargement…</p>
      ) : shown.length === 0 ? (
        <Empty>{filter === "todo" ? "Aucune DPAE en attente." : "Aucun salarié. Ajoutez-en un ou importez un fichier."}</Empty>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {shown.map((e) => {
            const check = checkDpae(e);
            return (
              <li key={e.id}>
                <Card className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-semibold">{e.prenom} {e.nom}</div>
                      <div className="text-sm text-muted">
                        {e.poste || "Poste ?"} · {e.typeContrat} · embauche le {fr(e.dateEmbauche)} à {e.heureEmbauche}
                      </div>
                    </div>
                    {e.dpaeStatut === "declaree" ? (
                      <Badge tone="green">Déclarée</Badge>
                    ) : check.ok ? (
                      <Badge tone="orange">À déclarer</Badge>
                    ) : (
                      <Badge tone="red">Incomplet</Badge>
                    )}
                  </div>
                  {e.dpaeStatut === "declaree" ? (
                    <p className="text-sm text-muted">
                      Déclarée le {fr(e.dpaeDateDeclaration)}{e.dpaeNumeroAccuse ? ` · accusé n° ${e.dpaeNumeroAccuse}` : ""}
                    </p>
                  ) : (
                    (check.errors.length > 0 || check.warnings.length > 0) && (
                      <ul className="space-y-1 text-sm">
                        {check.errors.map((m) => <li key={m} className="text-danger">• {m}</li>)}
                        {check.warnings.map((m) => <li key={m} className="text-warning">• {m}</li>)}
                      </ul>
                    )
                  )}
                  <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                    <Button variant="secondary" onClick={() => setEditing(e)}>Modifier</Button>
                    {e.dpaeStatut !== "declaree" && (
                      <>
                        <Button variant="secondary" onClick={() => copySheet(e)} disabled={!check.ok}>Copier fiche DPAE</Button>
                        <Button className="col-span-2" onClick={() => setDeclaring(e)} disabled={!check.ok}>Marquer déclarée</Button>
                      </>
                    )}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet open={editing !== null} onClose={close} title={editing === "new" ? "Nouveau salarié" : "Modifier le salarié"}>
        {editing !== null && <EmployeeForm initial={editing === "new" ? null : editing} onDone={close} />}
      </Sheet>

      <Sheet open={importRows !== null} onClose={() => setImportRows(null)} title={`Importer ${importRows?.length ?? 0} salarié(s)`}>
        <ul className="mb-4 space-y-2">
          {importRows?.map((r, i) => {
            const c = checkDpae({ ...r, dpaeStatut: "a_declarer" });
            return (
              <li key={i} className="flex items-center justify-between gap-2 rounded-control border border-border p-2 text-sm">
                <span className="truncate">{r.prenom} {r.nom} · {fr(r.dateEmbauche) || "date ?"}</span>
                {c.ok ? <Badge tone="green">OK</Badge> : <Badge tone="red">{c.errors.length} erreur(s)</Badge>}
              </li>
            );
          })}
        </ul>
        <p className="mb-3 text-sm text-muted">Les lignes incomplètes sont importées quand même ; vous les compléterez ensuite.</p>
        <Button className="w-full" onClick={confirmImport}>Importer</Button>
      </Sheet>

      <Sheet open={declaring !== null} onClose={() => setDeclaring(null)} title="DPAE effectuée">
        {declaring && <DeclareForm employee={declaring} onDone={() => setDeclaring(null)} />}
      </Sheet>
    </div>
  );
}

function DeclareForm({ employee, onDone }: { employee: WithId<Employee>; onDone: () => void }) {
  const [numero, setNumero] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await updateDoc(doc(db(), "employees", employee.id), {
        dpaeStatut: "declaree",
        dpaeDateDeclaration: date,
        dpaeNumeroAccuse: numero.trim(),
      });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-muted">{employee.prenom} {employee.nom}</p>
      <Field label="Date de la déclaration"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="N° d'accusé de réception" hint="Indiqué sur l'accusé reçu après l'envoi.">
        <Input value={numero} onChange={(e) => setNumero(e.target.value)} />
      </Field>
      <ErrorBox message={error} />
      <Button type="submit" className="w-full">Enregistrer</Button>
    </form>
  );
}

function EmployeeForm({ initial, onDone }: { initial: WithId<Employee> | null; onDone: () => void }) {
  const [f, setF] = useState<EmployeeDraft>(() => {
    if (!initial) return EMPTY;
    const draft: EmployeeDraft = { ...EMPTY };
    for (const k of Object.keys(EMPTY).concat(["nomNaissance", "adresse", "dateFinContrat"]) as (keyof EmployeeDraft)[]) {
      if (initial[k] !== undefined) (draft as Record<string, unknown>)[k] = initial[k];
    }
    return draft;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof EmployeeDraft>(k: K, v: EmployeeDraft[K]) => setF((p) => ({ ...p, [k]: v }));
  const check = checkDpae({ ...f, dpaeStatut: initial?.dpaeStatut ?? "a_declarer" });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const data = clean({ ...f, nom: f.nom.toUpperCase(), nir: f.nir.replace(/\s/g, "") });
    try {
      if (initial) await updateDoc(doc(db(), "employees", initial.id), { ...data });
      else await addDoc(collection(db(), "employees"), { ...data, dpaeStatut: "a_declarer", createdAt: Date.now() });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!initial || !confirm(`Supprimer ${initial.prenom} ${initial.nom} ?`)) return;
    await deleteDoc(doc(db(), "employees", initial.id));
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nom"><Input required value={f.nom} onChange={(e) => set("nom", e.target.value)} /></Field>
        <Field label="Prénom"><Input required value={f.prenom} onChange={(e) => set("prenom", e.target.value)} /></Field>
        <Field label="Nom de naissance" hint="Si différent"><Input value={f.nomNaissance ?? ""} onChange={(e) => set("nomNaissance", e.target.value)} /></Field>
        <Field label="Sexe">
          <Select value={f.sexe} onChange={(e) => set("sexe", e.target.value as "M" | "F")}>
            <option value="M">Masculin</option>
            <option value="F">Féminin</option>
          </Select>
        </Field>
        <Field label="N° de sécurité sociale" hint="15 chiffres, clé comprise">
          <Input inputMode="numeric" value={f.nir} onChange={(e) => set("nir", e.target.value)} />
        </Field>
        <Field label="Date de naissance"><Input type="date" value={f.dateNaissance} onChange={(e) => set("dateNaissance", e.target.value)} /></Field>
        <Field label="Commune de naissance"><Input value={f.lieuNaissance} onChange={(e) => set("lieuNaissance", e.target.value)} /></Field>
        <Field label="Département de naissance" hint="99 si né à l'étranger">
          <Input value={f.departementNaissance} onChange={(e) => set("departementNaissance", e.target.value)} />
        </Field>
        <Field label="Nationalité"><Input value={f.nationalite} onChange={(e) => set("nationalite", e.target.value)} /></Field>
        <Field label="Poste"><Input value={f.poste} onChange={(e) => set("poste", e.target.value)} /></Field>
        <Field label="Date d'embauche"><Input type="date" required value={f.dateEmbauche} onChange={(e) => set("dateEmbauche", e.target.value)} /></Field>
        <Field label="Heure d'embauche"><Input type="time" value={f.heureEmbauche} onChange={(e) => set("heureEmbauche", e.target.value)} /></Field>
        <Field label="Contrat">
          <Select value={f.typeContrat} onChange={(e) => set("typeContrat", e.target.value as TypeContrat)}>
            {["CDI", "CDD", "Apprentissage", "Extra", "Interim"].map((c) => <option key={c}>{c}</option>)}
          </Select>
        </Field>
        {f.typeContrat !== "CDI" && (
          <Field label="Date de fin de contrat">
            <Input type="date" value={f.dateFinContrat ?? ""} onChange={(e) => set("dateFinContrat", e.target.value)} />
          </Field>
        )}
      </div>
      {!check.ok && (
        <ul className="rounded-control bg-warning-soft p-3 text-sm text-warning">
          {check.errors.map((m) => <li key={m}>• {m}</li>)}
        </ul>
      )}
      <ErrorBox message={error} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        {initial ? <Button type="button" variant="danger" onClick={remove}>Supprimer</Button> : <span />}
        <Button type="submit" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</Button>
      </div>
    </form>
  );
}
