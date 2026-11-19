"use client";

import Link from "next/link";
import { deleteField, doc, onSnapshot, setDoc, updateDoc, FieldPath } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { nomFichier, PdfPages, usePdf } from "@/components/PdfApercu";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, Empty, ErrorBox, Input, PageHeader, Select } from "@/components/ui";
import { db } from "@/lib/firebase";
import { ORDRE_STATUTS, type FactureLiee, type GroupeCB, type LigneJustifiee, type ResumeMois, type StatutLigne } from "@/lib/justification";
import { formatEuros } from "@/lib/money";
import { restaurant } from "@/lib/restaurants";

interface IndexReleve {
  le: number;
  debut?: string;
  fin?: string;
  mois: ResumeMois[];
}
interface MoisReleve {
  le: number;
  mois: string;
  lignes: LigneJustifiee[];
  groupesCB: Record<string, GroupeCB>;
}
/** settings/releveVu-AAAA-MM : lignes revues à l'œil par le gérant, avec une note facultative. */
type Vus = Record<string, { le: number; note?: string }>;

const fr = (iso: string) => iso.split("-").reverse().join("/");
const NOMS_MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const nomMois = (m: string) => `${NOMS_MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const jourSemaine = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

const STATUTS: Record<StatutLigne, { label: string; court: string; tone: "green" | "info" | "orange" | "red" | "neutral"; barre: string; bord: string }> = {
  justifie: { label: "Justifiée", court: "Justifiées", tone: "green", barre: "bg-success", bord: "border-l-success" },
  explique: { label: "Expliquée, sans pièce", court: "Expliquées", tone: "info", barre: "bg-info", bord: "border-l-info" },
  attente: { label: "En attente", court: "En attente", tone: "neutral", barre: "bg-muted", bord: "border-l-border" },
  anomalie: { label: "À regarder", court: "À regarder", tone: "orange", barre: "bg-warning", bord: "border-l-warning" },
  non_justifie: { label: "Non justifiée", court: "Non justifiées", tone: "red", barre: "bg-danger", bord: "border-l-danger" },
};

type Filtre = "tout" | StatutLigne | "a_voir" | "non_vues";

export default function RelevePage() {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [index, setIndex] = useState<IndexReleve | null | undefined>(undefined);
  const [mois, setMois] = useState<string | null>(null);
  const [data, setData] = useState<MoisReleve | null | undefined>(undefined);
  const [vus, setVus] = useState<Vus>({});
  const [filtre, setFiltre] = useState<Filtre>("a_voir");
  const [sens, setSens] = useState<"tous" | "credits" | "debits">("tous");
  const [cherche, setCherche] = useState("");
  const [calcul, setCalcul] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  // Un seul document pour la liste des mois, puis un document par mois affiché (quota Firestore).
  useEffect(
    () =>
      onSnapshot(
        doc(db(), "restaurants", rid, "settings", "releve"),
        (s) => setIndex(s.exists() ? (s.data() as IndexReleve) : null),
        (e) => {
          setErreur(e.message);
          setIndex(null);
        },
      ),
    [rid],
  );
  const moisAffiche = mois ?? index?.mois.at(-1)?.mois ?? null;
  useEffect(() => {
    if (!moisAffiche) return;
    const a = onSnapshot(
      doc(db(), "restaurants", rid, "settings", `releve-${moisAffiche}`),
      (s) => setData(s.exists() ? (s.data() as MoisReleve) : null),
      (e) => setErreur(e.message),
    );
    const b = onSnapshot(
      doc(db(), "restaurants", rid, "settings", `releveVu-${moisAffiche}`),
      (s) => setVus((s.data() as Vus | undefined) ?? {}),
      () => setVus({}),
    );
    return () => {
      a();
      b();
    };
  }, [rid, moisAffiche]);

  async function recalculer() {
    if (!user) return;
    setErreur(null);
    setCalcul(true);
    try {
      const res = await fetch(`/api/releve?r=${rid}`, { method: "POST", headers: { authorization: `Bearer ${await user.getIdToken()}` } });
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(b.error ?? `Erreur ${res.status}`);
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setCalcul(false);
    }
  }

  async function marquer(l: LigneJustifiee, vu: boolean, note?: string) {
    if (!moisAffiche) return;
    setErreur(null);
    const ref = doc(db(), "restaurants", rid, "settings", `releveVu-${moisAffiche}`);
    try {
      const le = new Date().getTime();
      if (vu) await setDoc(ref, { [l.id]: { le, ...(note?.trim() ? { note: note.trim().slice(0, 300) } : {}) } }, { merge: true });
      else await updateDoc(ref, new FieldPath(l.id), deleteField());
    } catch (e) {
      setErreur((e as Error).message);
    }
  }

  const lignes = useMemo(() => (data?.mois === moisAffiche ? data.lignes : []), [data, moisAffiche]);
  const resume = index?.mois.find((m) => m.mois === moisAffiche);
  const nbVues = lignes.filter((l) => vus[l.id]).length;
  const compte = (f: Filtre) => lignes.filter((l) => garder(l, f, vus)).length;
  const visibles = useMemo(() => {
    const q = cherche.trim().toLowerCase().replace(",", ".");
    return lignes.filter(
      (l) =>
        garder(l, filtre, vus) &&
        (sens === "tous" || (sens === "credits" ? l.montant > 0 : l.montant < 0)) &&
        (!q || `${l.libelle} ${l.texte} ${l.nature} ${(Math.abs(l.montant) / 100).toFixed(2)}`.toLowerCase().includes(q)),
    );
  }, [lignes, filtre, vus, sens, cherche]);
  const parJour = useMemo(() => {
    const m = new Map<string, LigneJustifiee[]>();
    for (const l of [...visibles].reverse()) m.set(l.date, [...(m.get(l.date) ?? []), l]);
    return [...m];
  }, [visibles]);

  return (
    <div>
      <PageHeader
        title="Relevé de compte"
        action={
          <Button variant="secondary" onClick={recalculer} disabled={calcul || !user}>
            {calcul ? "Calcul…" : "Recalculer"}
          </Button>
        }
      />
      <p className="mb-4 text-sm text-muted">
        Chaque opération du compte {restaurant(rid).court}, avec ce qui la justifie : facture fournisseur, journée de caisse, versement Uber Eats, virement
        d&apos;un émetteur de titres-restaurant… Coche « Vérifiée » au fur et à mesure de ta relecture.
      </p>
      <ErrorBox message={erreur} />

      {index === undefined ? (
        <p className="text-sm text-muted">Chargement…</p>
      ) : !index || !index.mois.length ? (
        <Empty>
          Pas encore de relevé justifié pour {restaurant(rid).court}.{" "}
          {index ? "Aucune opération bancaire : relie la banque dans Caisse." : "Appuie sur « Recalculer » pour le préparer."}
        </Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,14rem)_1fr] sm:items-end">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-muted">Mois</span>
              <Select value={moisAffiche ?? ""} onChange={(e) => setMois(e.target.value)}>
                {[...index.mois].reverse().map((m) => (
                  <option key={m.mois} value={m.mois}>
                    {nomMois(m.mois)} · {m.statuts.non_justifie + m.statuts.anomalie} à voir
                  </option>
                ))}
              </Select>
            </label>
            {resume && <Bilan resume={resume} vues={nbVues} />}
          </div>

          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="group" aria-label="Filtrer par statut">
            {(["a_voir", "tout", ...ORDRE_STATUTS, "non_vues"] as Filtre[]).map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filtre === f}
                onClick={() => setFiltre(f)}
                className={`min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium ${filtre === f ? "border-bar bg-bar text-white" : "border-border bg-surface text-ink"}`}
              >
                {f === "tout" ? "Tout" : f === "a_voir" ? "À voir" : f === "non_vues" ? "Pas encore vérifiées" : STATUTS[f].court} ({compte(f)})
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <Input type="search" placeholder="Chercher un libellé ou un montant" value={cherche} onChange={(e) => setCherche(e.target.value)} aria-label="Chercher" />
            <div className="grid grid-cols-3 overflow-hidden rounded-control border border-border" role="group" aria-label="Sens">
              {(["tous", "credits", "debits"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sens === s}
                  onClick={() => setSens(s)}
                  className={`min-h-12 px-3 text-sm font-medium ${sens === s ? "bg-bar text-white" : "bg-surface"}`}
                >
                  {s === "tous" ? "Tout" : s === "credits" ? "Crédits" : "Débits"}
                </button>
              ))}
            </div>
          </div>

          {data === undefined ? (
            <p className="text-sm text-muted">Chargement du mois…</p>
          ) : !visibles.length ? (
            <Empty>{filtre === "a_voir" ? "Rien à voir ce mois-ci : toutes les lignes sont justifiées ou expliquées." : "Aucune ligne pour ce filtre."}</Empty>
          ) : (
            <div className="space-y-5">
              {parJour.map(([jour, ls]) => (
                <section key={jour} aria-label={jourSemaine(jour)}>
                  <h2 className="sticky top-[calc(env(safe-area-inset-top)+3.5rem)] z-10 -mx-4 mb-2 bg-bg/95 px-4 py-1 text-sm font-semibold capitalize text-muted backdrop-blur md:top-0 md:mx-0 md:px-0">
                    {jourSemaine(jour)}
                  </h2>
                  <div className="space-y-2">
                    {ls.map((l) => (
                      <Ligne key={l.id} l={l} groupe={l.cb ? data?.groupesCB[l.cb] : undefined} vu={vus[l.id]} onVu={(v, note) => marquer(l, v, note)} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
          <p className="text-xs text-muted">
            Calculé le {new Date(index.le).toLocaleString("fr-FR", { timeZone: "Europe/Paris", dateStyle: "short", timeStyle: "short" })}
            {index.debut ? ` · relevé bancaire depuis le ${fr(index.debut)}` : ""}. Recalculé chaque jour et après chaque relevé de la banque.
          </p>
        </div>
      )}
    </div>
  );
}

function garder(l: LigneJustifiee, f: Filtre, vus: Vus) {
  if (f === "tout") return true;
  if (f === "a_voir") return (l.statut === "non_justifie" || l.statut === "anomalie") && !vus[l.id];
  if (f === "non_vues") return !vus[l.id];
  return l.statut === f;
}

function Bilan({ resume, vues }: { resume: ResumeMois; vues: number }) {
  return (
    <Card className="space-y-2 p-3">
      <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-sm">
        <span>
          <span className="text-muted">Crédits</span> <strong className="tabular-nums text-success">+{formatEuros(resume.credits)}</strong>
        </span>
        <span>
          <span className="text-muted">Débits</span> <strong className="tabular-nums">−{formatEuros(resume.debits)}</strong>
        </span>
        <span>
          <span className="text-muted">Vérifiées</span>{" "}
          <strong className="tabular-nums">
            {vues}/{resume.lignes}
          </strong>
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        {[...ORDRE_STATUTS].reverse().map((s) => (resume.statuts[s] ? <div key={s} className={STATUTS[s].barre} style={{ width: `${(resume.statuts[s] / resume.lignes) * 100}%` }} /> : null))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-caption text-muted">
        {[...ORDRE_STATUTS].reverse().map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className={`inline-block size-2 rounded-full ${STATUTS[s].barre}`} aria-hidden />
            {resume.statuts[s]} {STATUTS[s].court.toLowerCase()}
          </span>
        ))}
      </div>
    </Card>
  );
}

function Ligne({ l, groupe, vu, onVu }: { l: LigneJustifiee; groupe?: GroupeCB; vu?: { le: number; note?: string }; onVu: (vu: boolean, note?: string) => void }) {
  const [note, setNote] = useState(vu?.note ?? "");
  const [ouvert, setOuvert] = useState(false);
  const s = STATUTS[l.statut];
  return (
    <Card className={`space-y-2 border-l-4 p-3 ${s.bord} ${vu ? "opacity-80" : ""}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="break-words text-sm font-medium leading-snug">{l.libelle || "(sans libellé)"}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={s.tone}>{s.label}</Badge>
            <span className="text-caption text-muted">{l.nature}</span>
            {vu && <Badge tone="green">✓ Vérifiée</Badge>}
          </div>
        </div>
        <div className={`shrink-0 text-right font-semibold tabular-nums ${l.montant > 0 ? "text-success" : ""}`}>
          {l.montant > 0 ? "+" : "−"}
          {formatEuros(Math.abs(l.montant))}
        </div>
      </div>
      <p className="text-sm leading-relaxed text-ink/90">{l.texte}</p>

      {groupe && groupe.jours.length > 0 && (
        <details className="rounded-control bg-surface-2 p-2 text-sm">
          <summary className="min-h-8 cursor-pointer font-medium">
            Crédit CB du {fr(groupe.credit)} : {groupe.remises} remise(s), {formatEuros(groupe.banque)}
          </summary>
          <ul className="mt-2 space-y-1">
            {groupe.jours.map((j) => (
              <li key={j.date} className="flex justify-between gap-2">
                <Link href={`/rapprochement?jour=${j.date}`} className="underline">
                  CB au ticket Z du {fr(j.date)}
                </Link>
                <span className="tabular-nums">{formatEuros(j.montant)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-2 border-t border-border pt-1">
              <span>Écart banque − caisse{groupe.titres ? " (tickets-resto)" : ""}</span>
              <span className="tabular-nums">{formatEuros(groupe.ecart)}</span>
            </li>
          </ul>
        </details>
      )}

      {l.factures && l.factures.length > 0 && (
        <ul className="space-y-2">
          {l.factures.map((f) => (
            <FactureLigne key={f.id} f={f} />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {l.lien && (
          <Link href={l.lien} className="inline-flex min-h-11 items-center rounded-control border border-border px-3 text-sm font-medium">
            {l.lien.startsWith("/rapprochement") ? "Ouvrir la caisse" : "Ouvrir dans Factures"}
          </Link>
        )}
        {vu ? (
          <>
            <button type="button" onClick={() => onVu(false)} className="inline-flex min-h-11 items-center rounded-control px-3 text-sm text-muted underline">
              Annuler la vérification
            </button>
            {vu.note && !ouvert && <span className="text-sm italic text-muted">« {vu.note} »</span>}
            {!ouvert && (
              <button type="button" onClick={() => setOuvert(true)} className="inline-flex min-h-11 items-center px-2 text-sm underline">
                {vu.note ? "Modifier la note" : "Ajouter une note"}
              </button>
            )}
          </>
        ) : (
          <>
            <Button className="min-h-11" onClick={() => onVu(true, note)}>
              Vérifiée
            </Button>
            {!ouvert && (
              <button type="button" onClick={() => setOuvert(true)} className="inline-flex min-h-11 items-center px-2 text-sm underline">
                Avec une note
              </button>
            )}
          </>
        )}
      </div>
      {ouvert && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex. facture papier rangée au classeur" aria-label="Note" maxLength={300} />
          <Button
            variant="secondary"
            onClick={() => {
              onVu(true, note);
              setOuvert(false);
            }}
          >
            Enregistrer
          </Button>
        </div>
      )}
    </Card>
  );
}

function FactureLigne({ f }: { f: FactureLiee }) {
  const pdf = usePdf(`f=${encodeURIComponent(f.id)}`);
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-control border border-border p-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <strong>{f.fournisseur}</strong> · n° {f.numero || "?"} · {fr(f.date)}
        </span>
        <span className="tabular-nums">{formatEuros(f.ttc)}</span>
      </div>
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          if (!open && !pdf.data && !pdf.busy) void pdf.charger();
        }}
        className="mt-1 inline-flex min-h-11 items-center font-medium underline"
      >
        {open ? "Masquer la facture" : "Voir la facture"}
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          {pdf.busy && <p className="text-muted">Chargement du PDF…</p>}
          <ErrorBox message={pdf.error} />
          {pdf.data && <PdfPages data={pdf.data} fichier={nomFichier(f.fournisseur, f.numero)} hauteur="max-h-[60dvh]" />}
        </div>
      )}
    </li>
  );
}
