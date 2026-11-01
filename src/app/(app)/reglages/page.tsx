"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select } from "@/components/ui";
import { db } from "@/lib/firebase";
import { DEFAULT_RULES, mergeRules, type MailRules } from "@/lib/mail";
import {
  coutUsd,
  DEFAULT_REGLAGES,
  FREQUENCES,
  JETONS_FACTURE_TYPE,
  MODELES,
  moisCle,
  parseConsommation,
  parseReglages,
  type ModeleIA,
  type Reglages,
} from "@/lib/reglages";

const usd = (v: number) => `${v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
const lignes = (l: string[]) => l.join("\n");
const liste = (t: string) =>
  t
    .split(/\n|,/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
const moisPrecedent = () => {
  const [y, m] = moisCle().split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const nomMois = (ym: string) => new Date(`${ym}-15`).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
const frequenceLabel = (h: number) => (h === 24 ? "1 fois par jour" : h === 1 ? "toutes les heures" : `toutes les ${h} heures`);

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex min-h-12 cursor-pointer items-center justify-between gap-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span
        aria-hidden
        className="relative h-7 w-12 shrink-0 rounded-full bg-border transition peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary/60 after:absolute after:left-1 after:top-1 after:size-5 after:rounded-full after:bg-surface after:shadow after:transition peer-checked:after:translate-x-5"
      />
    </label>
  );
}

function Liste({ label, hint, value, onChange }: { label: string; hint: string; value: string[]; onChange: (v: string[]) => void }) {
  const [text, setText] = useState(lignes(value));
  const [vu, setVu] = useState(value);
  // Valeur changée de l'extérieur (enregistrement, règles par défaut) : on resynchronise le texte.
  if (vu !== value) {
    setVu(value);
    setText(lignes(value));
  }
  return (
    <Field label={label} hint={hint}>
      <textarea
        rows={Math.min(8, Math.max(3, value.length + 1))}
        className="w-full min-w-0 rounded-control border border-border bg-surface p-3 text-base outline-none focus:border-ink focus:ring-2 focus:ring-primary/60"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => onChange(liste(text))}
      />
    </Field>
  );
}

interface MailDoc {
  reglages?: unknown;
  regles?: Partial<MailRules>;
  consommation?: Record<string, unknown>;
  dernierResultat?: { lecturePdf?: boolean };
  adresse?: string;
}

export default function ReglagesPage() {
  const { rid, current } = useRestaurant();
  const { user } = useAuth();
  const [data, setData] = useState<MailDoc | null>(null);
  const [reglages, setReglages] = useState<Reglages>(DEFAULT_REGLAGES);
  const [regles, setRegles] = useState<MailRules>(DEFAULT_RULES);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [nouvelExp, setNouvelExp] = useState("");
  const [nouveauNom, setNouveauNom] = useState("");

  useEffect(
    () =>
      onSnapshot(
        doc(db(), "restaurants", rid, "settings", "mail"),
        (s) => {
          const d = (s.data() as MailDoc) ?? {};
          setData(d);
          if (!dirty) {
            setReglages(parseReglages(d.reglages));
            setRegles(mergeRules(d.regles));
          }
        },
        (e) => setError(e.message),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rid],
  );

  const setR = <K extends keyof Reglages>(k: K, v: Reglages[K]) => {
    setReglages((r) => ({ ...r, [k]: v }));
    setDirty(true);
    setInfo(null);
  };
  const setRule = <K extends keyof MailRules>(k: K, v: MailRules[K]) => {
    setRegles((r) => ({ ...r, [k]: v }));
    setDirty(true);
    setInfo(null);
  };

  async function save() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/reglages?r=${rid}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ reglages, regles }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `Erreur ${res.status}`);
      setDirty(false);
      setInfo(`Réglages de ${current.court} enregistrés.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const ce = parseConsommation(data?.consommation?.[moisCle()]);
  const avant = parseConsommation(data?.consommation?.[moisPrecedent()]);
  const parFacture = (m: ModeleIA) => coutUsd(m, JETONS_FACTURE_TYPE.entree, JETONS_FACTURE_TYPE.sortie);
  const budget = reglages.budgetMensuelUsd;
  const pct = budget > 0 ? Math.min(100, (ce.coutUsd / budget) * 100) : 0;
  const cleAbsente = data?.dernierResultat?.lecturePdf === false && reglages.lecturePdf;
  const fournisseurs = Object.entries(regles.fournisseurs).sort((a, b) => a[1].localeCompare(b[1]));

  return (
    <div className="space-y-4 pb-24">
      <PageHeader title="Réglages" action={<Badge>{current.court}</Badge>} />
      <p className="text-sm text-muted">Ces réglages ne concernent que {current.nom}. Change de restaurant avec la pastille pour régler l&rsquo;autre.</p>

      {/* Lecture des PDF */}
      <Card className="space-y-4">
        <h2 className="font-semibold">Lecture des factures par Claude</h2>
        <Toggle
          checked={reglages.lecturePdf}
          onChange={(v) => setR("lecturePdf", v)}
          label="Lire les PDF automatiquement"
          hint="Coupé : les factures arrivent « à compléter », tu saisis les montants."
        />
        {cleAbsente && <p className="rounded-control bg-warning-soft p-3 text-sm">La clé ANTHROPIC_API_KEY n&rsquo;est pas active dans Vercel : aucune lecture pour l&rsquo;instant.</p>}

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Modèle" hint={`≈ ${usd(parFacture(reglages.modele))} par facture`}>
            <Select value={reglages.modele} onChange={(e) => setR("modele", e.target.value as ModeleIA)}>
              {(Object.keys(MODELES) as ModeleIA[]).map((m) => (
                <option key={m} value={m}>
                  {MODELES[m].nom} – {MODELES[m].detail}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Budget par mois ($)" hint="0 = pas de limite. Au-delà, plus de lecture ce mois-ci.">
            <Input type="number" inputMode="decimal" min={0} step={1} value={reglages.budgetMensuelUsd} onChange={(e) => setR("budgetMensuelUsd", Number(e.target.value))} />
          </Field>
          <Field label="PDF lus au maximum par vérification" hint="Le reste est lu à la vérification suivante.">
            <Input type="number" inputMode="numeric" min={1} max={500} value={reglages.maxLecturesParVerification} onChange={(e) => setR("maxLecturesParVerification", Number(e.target.value))} />
          </Field>
        </div>

        <div className="space-y-2 rounded-control bg-surface-2 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-medium">Dépense de {nomMois(moisCle())}</span>
            <span className="font-display text-2xl">
              {usd(ce.coutUsd)}
              {budget > 0 && <span className="text-base text-muted"> / {usd(budget)}</span>}
            </span>
          </div>
          {budget > 0 && (
            <div className="h-2 overflow-hidden rounded-full bg-border" aria-hidden>
              <div className={`h-full ${pct >= 90 ? "bg-danger" : "bg-primary"}`} style={{ width: `${pct}%` }} />
            </div>
          )}
          <p className="text-xs text-muted">
            {ce.lectures} lecture{ce.lectures > 1 ? "s" : ""}
            {ce.lectures ? ` · ${usd(ce.coutUsd / ce.lectures)} en moyenne` : ""}
            {avant.lectures ? ` · ${nomMois(moisPrecedent())} : ${usd(avant.coutUsd)} (${avant.lectures} lectures)` : ""}
          </p>
        </div>
        <p className="text-xs text-muted">
          Filet de sécurité : fixe aussi une limite sur{" "}
          <a className="underline" href="https://console.anthropic.com/settings/limits" target="_blank" rel="noreferrer">
            console.anthropic.com → Limits
          </a>
          . Montants en dollars, facturés par Anthropic.
        </p>
      </Card>

      {/* Relevé automatique */}
      <Card className="space-y-4">
        <h2 className="font-semibold">Relevé automatique</h2>
        <Toggle checked={reglages.releveAuto} onChange={(v) => setR("releveAuto", v)} label="Relever la boîte mail tout seul" hint={data?.adresse ? `Boîte : ${data.adresse}` : "Boîte non connectée (page À vérifier)."} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fréquence" hint="Gratuit : chaque PDF n'est lu qu'une fois, quelle que soit la fréquence.">
            <Select value={reglages.frequenceHeures} disabled={!reglages.releveAuto} onChange={(e) => setR("frequenceHeures", Number(e.target.value))}>
              {FREQUENCES.map((h) => (
                <option key={h} value={h}>
                  {frequenceLabel(h)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Jours relus au maximum" hint="Au premier relevé, ou après une longue coupure.">
            <Input type="number" inputMode="numeric" min={1} max={90} value={reglages.joursPremierReleve} onChange={(e) => setR("joursPremierReleve", Number(e.target.value))} />
          </Field>
        </div>
      </Card>

      {/* Tri des mails */}
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Tri des mails</h2>
          <Button
            variant="ghost"
            className="min-h-10 px-2 text-xs"
            onClick={() => {
              if (confirm("Remettre les règles de tri par défaut ?")) {
                setRegles(DEFAULT_RULES);
                setDirty(true);
              }
            }}
          >
            Règles par défaut
          </Button>
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium text-muted">Fournisseurs connus (expéditeur → nom)</div>
          <ul className="divide-y divide-border rounded-control border border-border">
            {fournisseurs.map(([exp, nom]) => (
              <li key={exp} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{nom}</div>
                  <div className="truncate text-xs text-muted">{exp}</div>
                </div>
                <Button
                  variant="ghost"
                  className="min-h-10 px-2"
                  aria-label={`Retirer ${nom}`}
                  onClick={() => {
                    const f = { ...regles.fournisseurs };
                    delete f[exp];
                    setRule("fournisseurs", f);
                  }}
                >
                  ✕
                </Button>
              </li>
            ))}
            {!fournisseurs.length && <li className="px-3 py-2 text-sm text-muted">Aucun fournisseur.</li>}
          </ul>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input placeholder="Adresse ou domaine (ex. hpsrungis.com)" value={nouvelExp} onChange={(e) => setNouvelExp(e.target.value)} />
            <Input placeholder="Nom du fournisseur" value={nouveauNom} onChange={(e) => setNouveauNom(e.target.value)} />
            <Button
              variant="secondary"
              disabled={!nouvelExp.trim() || !nouveauNom.trim()}
              onClick={() => {
                setRule("fournisseurs", { ...regles.fournisseurs, [nouvelExp.trim().toLowerCase()]: nouveauNom.trim() });
                setNouvelExp("");
                setNouveauNom("");
              }}
            >
              Ajouter
            </Button>
          </div>
        </div>

        <Liste label="À ignorer" hint="Une adresse, un domaine ou un mot de l'objet par ligne." value={regles.ignorer} onChange={(v) => setRule("ignorer", v)} />
        <Liste label="Mots qui signalent une facture" hint="Pour les expéditeurs inconnus avec un PDF (objet ou nom du fichier)." value={regles.factureMotsCles} onChange={(v) => setRule("factureMotsCles", v)} />
        <Liste label="Mots qui écartent un mail" hint="Relances, relevés de compte… (objet)." value={regles.factureExclure} onChange={(v) => setRule("factureExclure", v)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Liste label="Expéditeurs Uber Eats" hint="Adresse ou domaine." value={regles.uberExpediteurs} onChange={(v) => setRule("uberExpediteurs", v)} />
          <Liste label="Objet d'un récap de versement Uber" hint="Une expression par ligne." value={regles.uberMotsCles} onChange={(v) => setRule("uberMotsCles", v)} />
        </div>
      </Card>

      {info && <p className="rounded-control bg-success-soft p-3 text-sm">{info}</p>}
      <ErrorBox message={error} />

      {/* Barre d'enregistrement, au-dessus de la navigation du bas sur téléphone */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 border-t border-border bg-surface/95 p-3 backdrop-blur md:static md:border-0 md:bg-transparent md:p-0">
        <div className="mx-auto flex max-w-5xl items-center justify-end gap-2">
          {dirty && <span className="mr-auto text-sm text-muted">Modifications non enregistrées</span>}
          <Button className="w-full sm:w-auto" disabled={busy || !dirty} onClick={save}>
            {busy ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      </div>
    </div>
  );
}
