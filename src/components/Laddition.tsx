"use client";

import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, ErrorBox, Field, Input } from "@/components/ui";
import { db } from "@/lib/firebase";
import { CHAMPS_CA, chiffresCoherents, montantFr, parseMontantFr, type CaMensuel, type ChiffresCa } from "@/lib/laddition";

type User = { getIdToken: () => Promise<string> };

async function api<T>(user: User, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json", ...init.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `Erreur ${res.status}`), { diagnostic: json.diagnostic });
  return json as T;
}

const nomMois = (ym: string) => new Date(`${ym}-15`).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
const dateFr = (ms: number) => new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

interface Etat {
  configure: boolean;
  identifiant: string;
  etablissement: string;
  majLe: number | null;
  dernierImport: { mois: string; le: number } | null;
}

/** Réglages : identifiant et mot de passe L'Addition (envoyés au serveur, chiffrés, jamais relus). */
export function LadditionIdentifiants() {
  const { rid, current } = useRestaurant();
  const { user } = useAuth();
  const [etat, setEtat] = useState<Etat | null>(null);
  const [identifiant, setIdentifiant] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [etablissement, setEtablissement] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    let vivant = true;
    api<Etat>(user, `/api/laddition/identifiants?r=${rid}`)
      .then((e) => {
        if (!vivant) return;
        setEtat(e);
        setIdentifiant(e.identifiant);
        setEtablissement(e.etablissement);
      })
      .catch((e) => vivant && setError(e.message));
    return () => {
      vivant = false;
    };
  }, [rid, user]);

  async function enregistrer() {
    if (!user) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await api(user, `/api/laddition/identifiants?r=${rid}`, { method: "POST", body: JSON.stringify({ identifiant, motDePasse, etablissement }) });
      setMotDePasse("");
      setEtat((e) => ({ ...(e ?? { dernierImport: null }), configure: true, identifiant, etablissement, majLe: Date.now() }));
      setInfo("Identifiants enregistrés (mot de passe chiffré sur le serveur).");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function oublier() {
    if (!user || !confirm("Supprimer les identifiants L'Addition de ce restaurant ?")) return;
    setBusy(true);
    try {
      await api(user, `/api/laddition/identifiants?r=${rid}`, { method: "DELETE" });
      setEtat({ configure: false, identifiant: "", etablissement: "", majLe: null, dernierImport: null });
      setIdentifiant("");
      setEtablissement("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Caisse L&rsquo;Addition</h2>
        {etat && <Badge tone={etat.configure ? "green" : "neutral"}>{etat.configure ? "Connectée" : "Non configurée"}</Badge>}
      </div>
      <p className="text-sm text-muted">
        Sert à relever chaque mois le CA TTC net et le TTC par taux (10 %, 20 %, 5,5 %) pour le comptable, depuis l&rsquo;onglet TVA. Identifiants
        de {current.nom}.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Identifiant (e-mail)">
          <Input autoComplete="off" inputMode="email" value={identifiant} onChange={(e) => setIdentifiant(e.target.value)} />
        </Field>
        <Field label="Mot de passe" hint={etat?.configure ? "Laisse vide pour garder l'actuel." : undefined}>
          <Input type="password" autoComplete="new-password" value={motDePasse} onChange={(e) => setMotDePasse(e.target.value)} />
        </Field>
        <Field label="Établissement (facultatif)" hint="Si le compte donne accès aux deux restaurants : le nom affiché dans L'Addition.">
          <Input value={etablissement} onChange={(e) => setEtablissement(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={enregistrer} disabled={busy || !identifiant || (!motDePasse && !etat?.configure)}>
          Enregistrer
        </Button>
        {etat?.configure && (
          <Button variant="ghost" onClick={oublier} disabled={busy}>
            Supprimer
          </Button>
        )}
      </div>
      {etat?.dernierImport && (
        <p className="text-xs text-muted">
          Dernier relevé : {nomMois(etat.dernierImport.mois)}, le {dateFr(etat.dernierImport.le)}.
        </p>
      )}
      {info && <p className="text-sm text-success">{info}</p>}
      <ErrorBox message={error} />
    </Card>
  );
}

type CaDoc = Record<string, CaMensuel>;

/** Écoute settings/caMensuel du restaurant : { "2026-10": CaMensuel }. */
export function useCaMensuel(): { data: CaDoc; error: string | null } {
  const { rid } = useRestaurant();
  const [data, setData] = useState<CaDoc>({});
  const [error, setError] = useState<string | null>(null);
  useEffect(
    () =>
      onSnapshot(
        doc(db(), "restaurants", rid, "settings", "caMensuel"),
        (s) => setData((s.data() as CaDoc) ?? {}),
        (e) => setError(e.message),
      ),
    [rid],
  );
  return { data, error };
}

/** Onglet TVA : les quatre chiffres L'Addition du mois, relevés par le robot ou saisis à la main. */
export function LadditionCa({ mois, ca }: { mois: string; ca?: CaMensuel }) {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<string | null>(null);
  const [edition, setEdition] = useState<Record<keyof ChiffresCa, string> | null>(null);
  const [copie, setCopie] = useState(false);

  async function extraire() {
    if (!user) return;
    setBusy(true);
    setError(null);
    setDiag(null);
    try {
      await api(user, `/api/laddition/extraire?r=${rid}&mois=${mois}`, { method: "POST" });
    } catch (e) {
      setError((e as Error).message);
      const d = (e as { diagnostic?: unknown }).diagnostic;
      if (d) setDiag(JSON.stringify(d, null, 2));
    } finally {
      setBusy(false);
    }
  }

  function editer() {
    setEdition(Object.fromEntries(CHAMPS_CA.map(({ key }) => [key, ca ? montantFr(ca[key]) : ""])) as Record<keyof ChiffresCa, string>);
  }

  async function enregistrerManuel() {
    if (!edition) return;
    const valeurs = Object.fromEntries(CHAMPS_CA.map(({ key }) => [key, parseMontantFr(edition[key]) ?? 0])) as ChiffresCa;
    const entree: CaMensuel = { mois, ...valeurs, source: "manuel", majLe: Date.now(), coherent: chiffresCoherents(valeurs) };
    try {
      await setDoc(doc(db(), "restaurants", rid, "settings", "caMensuel"), { [mois]: entree }, { merge: true });
      setEdition(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function copier() {
    if (!ca) return;
    const texte = CHAMPS_CA.map(({ key, label }) => `${label} : ${montantFr(ca[key])} €`).join("\n");
    await navigator.clipboard.writeText(`L'Addition – ${nomMois(mois)}\n${texte}`);
    setCopie(true);
    setTimeout(() => setCopie(false), 2000);
  }

  return (
    <Card className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-medium">Chiffres L&rsquo;Addition · {nomMois(mois)}</div>
        {ca && (
          <Badge tone={ca.coherent === false ? "orange" : "green"}>
            {ca.source === "laddition" ? "Relevé L'Addition" : "Saisi à la main"} · {dateFr(ca.majLe)}
          </Badge>
        )}
      </div>

      {edition ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CHAMPS_CA.map(({ key, label }) => (
            <Field key={key} label={label}>
              <Input inputMode="decimal" value={edition[key]} onChange={(e) => setEdition({ ...edition, [key]: e.target.value })} />
            </Field>
          ))}
        </div>
      ) : ca ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {CHAMPS_CA.map(({ key, label }) => (
            <div key={key} className="min-w-0">
              <dt className="text-xs text-muted">{label}</dt>
              <dd className={`tabular-nums ${key === "caTtcNet" ? "text-lg font-semibold" : "font-medium"}`}>{montantFr(ca[key])} €</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted">Pas encore relevé pour ce mois.</p>
      )}

      {ca?.coherent === false && !edition && (
        <p className="rounded-control bg-warning-soft p-3 text-sm text-warning">
          10 % + 20 % + 5,5 % ne font pas le CA TTC net ({montantFr(ca.ttc10 + ca.ttc20 + ca.ttc55)} € au lieu de {montantFr(ca.caTtcNet)} €) : vérifie dans
          L&rsquo;Addition.
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {edition ? (
          <>
            <Button onClick={enregistrerManuel}>Enregistrer</Button>
            <Button variant="ghost" onClick={() => setEdition(null)}>
              Annuler
            </Button>
          </>
        ) : (
          <>
            <Button onClick={extraire} disabled={busy}>
              {busy ? "Lecture de L'Addition… (≈ 30 s)" : ca ? "Relire L'Addition" : "Relever dans L'Addition"}
            </Button>
            <Button variant="secondary" onClick={editer} disabled={busy}>
              Saisir à la main
            </Button>
            {ca && (
              <Button variant="ghost" onClick={copier}>
                {copie ? "Copié ✓" : "Copier"}
              </Button>
            )}
          </>
        )}
      </div>
      <ErrorBox message={error} />
      {diag && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Ce que le robot a vu (à transmettre pour corriger)</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control bg-bg p-2">{diag}</pre>
        </details>
      )}
    </Card>
  );
}
