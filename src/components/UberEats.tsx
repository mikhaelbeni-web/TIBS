"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, ErrorBox, Field, Input } from "@/components/ui";

type User = { getIdToken: () => Promise<string> };

export interface DiagnosticUber {
  etape: string;
  url: string;
  titre: string;
  texte: string;
  appels: string[];
  capture?: string;
}

export class ErreurRobot extends Error {
  constructor(
    message: string,
    public diagnostic?: DiagnosticUber,
  ) {
    super(message);
  }
}

export async function apiUber<T>(user: User, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json", ...init.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ErreurRobot(json.error || `Erreur ${res.status}`, json.diagnostic);
  return json as T;
}

const dateFr = (ms: number) => new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });

export interface EtatUber {
  configure: boolean;
  email: string;
  boutique: string;
  urlProblemes: string;
  modeAuto: boolean;
  majLe: number | null;
  sessionLe: number | null;
  dernierPassage: { le: number; ok: boolean; message: string; besoin?: string } | null;
}

export function useEtatUber() {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [etat, setEtat] = useState<EtatUber | null>(null);
  const [version, setVersion] = useState(0);
  const recharger = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    if (!user) return;
    let vivant = true;
    apiUber<EtatUber>(user, `/api/uber-eats/identifiants?r=${rid}`)
      .then((e) => vivant && setEtat(e))
      .catch(() => {});
    return () => {
      vivant = false;
    };
  }, [rid, user, version]);
  return { etat, recharger };
}

/** Ce que le robot a vu : capture d'écran et texte de la page, pour comprendre un échec ou vérifier un essai. */
export function VueRobot({ d }: { d?: DiagnosticUber }) {
  if (!d) return null;
  return (
    <details className="rounded-control border border-border p-3 text-sm" open={Boolean(d.capture)}>
      <summary className="cursor-pointer font-medium">Ce que le robot voit ({d.etape})</summary>
      {d.capture && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`data:image/jpeg;base64,${d.capture}`} alt="Capture de la page Uber Eats Manager" className="mt-2 w-full rounded-control border border-border" />
      )}
      <p className="mt-2 break-all text-xs text-muted">{d.url}</p>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{d.texte.slice(0, 2500)}</pre>
    </details>
  );
}

/** Bandeau de la page Contestations : état du robot et bouton « Relever maintenant ». */
export function RobotUber({ onFini }: { onFini: () => void }) {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const { etat, recharger } = useEtatUber();
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<ErreurRobot | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function relever() {
    if (!user) return;
    setBusy(true);
    setErreur(null);
    setInfo(null);
    try {
      const r = await apiUber<{ lues: number; ajoutees: number; montantsLus: number; contestees: string[]; echecs: unknown[] }>(user, `/api/uber-eats/relever?r=${rid}`, { method: "POST" });
      setInfo(
        `${r.lues} commande(s) lue(s) dans Uber Eats, ${r.ajoutees} nouvelle(s), ${r.montantsLus} montant(s) lu(s)` +
          (r.contestees.length || r.echecs.length ? `, ${r.contestees.length} contestée(s), ${r.echecs.length} échec(s).` : "."),
      );
      onFini();
    } catch (e) {
      setErreur(e as ErreurRobot);
    } finally {
      setBusy(false);
      recharger();
    }
  }

  if (!etat) return null;
  if (!etat.configure) {
    return (
      <Card className="mb-4 text-sm">
        Le robot peut relever et contester tout seul dans Uber Eats Manager. Renseigne d&rsquo;abord les identifiants dans{" "}
        <Link href="/reglages" className="underline">Réglages</Link>.
      </Card>
    );
  }
  const p = etat.dernierPassage;
  return (
    <Card className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm">
          <div className="font-semibold">
            Robot Uber Eats <Badge tone={etat.modeAuto ? "green" : "info"}>{etat.modeAuto ? "Contestation automatique" : "Tu valides chaque contestation"}</Badge>
          </div>
          {p ? (
            <div className={p.ok ? "text-muted" : "text-danger"}>
              Dernier passage le {dateFr(p.le)} : {p.message}
            </div>
          ) : (
            <div className="text-muted">Jamais lancé. Il passe tout seul deux fois par jour.</div>
          )}
        </div>
        <Button variant="secondary" onClick={relever} disabled={busy}>
          {busy ? "Le robot travaille (1 à 2 min)…" : "Relever maintenant"}
        </Button>
      </div>
      {info && <p className="text-sm text-success">{info}</p>}
      <ErrorBox message={erreur?.message ?? null} />
      <VueRobot d={erreur?.diagnostic} />
    </Card>
  );
}

/** Réglages : identifiants Uber Eats Manager du restaurant (envoyés au serveur, mot de passe chiffré, jamais relu). */
export function UberEatsIdentifiants() {
  const { rid, current } = useRestaurant();
  const { user } = useAuth();
  const { etat, recharger } = useEtatUber();
  const [f, setF] = useState({ email: "", motDePasse: "", boutique: "", urlProblemes: "", modeAuto: false });
  const [charge, setCharge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (etat && !charge) {
    setCharge(true);
    setF({ email: etat.email, motDePasse: "", boutique: etat.boutique, urlProblemes: etat.urlProblemes, modeAuto: etat.modeAuto });
  }
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function enregistrer() {
    if (!user) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await apiUber(user, `/api/uber-eats/identifiants?r=${rid}`, { method: "POST", body: JSON.stringify(f) });
      set("motDePasse", "");
      setInfo("Enregistré (mot de passe chiffré sur le serveur).");
      recharger();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function oublier() {
    if (!user || !confirm("Supprimer les identifiants Uber Eats de ce restaurant ?")) return;
    setBusy(true);
    try {
      await apiUber(user, `/api/uber-eats/identifiants?r=${rid}`, { method: "DELETE" });
      setF({ email: "", motDePasse: "", boutique: "", urlProblemes: "", modeAuto: false });
      recharger();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Uber Eats Manager</h2>
        {etat && <Badge tone={etat.configure ? "green" : "neutral"}>{etat.configure ? "Configuré" : "Non configuré"}</Badge>}
      </div>
      <p className="text-sm text-muted">
        Le robot se connecte à Uber Eats Manager pour {current.nom}, relève les commandes avec un problème et conteste celles marquées « Problème facturé » ou « Remboursement effectué par Uber ». Si Uber demande un code, il le lit dans la boîte Gmail du restaurant : le compte Uber doit donc utiliser cette adresse.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="E-mail du compte Uber Eats">
          <Input autoComplete="off" inputMode="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Mot de passe" hint={etat?.configure ? "Laisse vide pour garder l'actuel." : undefined}>
          <Input type="password" autoComplete="new-password" value={f.motDePasse} onChange={(e) => set("motDePasse", e.target.value)} />
        </Field>
        <Field label="Boutique (facultatif)" hint="Nom affiché dans Uber, ex. Tib's (K), si le compte voit les deux restaurants.">
          <Input value={f.boutique} onChange={(e) => set("boutique", e.target.value)} />
        </Field>
        <Field label="Adresse de la liste des problèmes (facultatif)" hint="Copie l'adresse de la page Uber Eats Manager qui montre le tableau des problèmes.">
          <Input inputMode="url" value={f.urlProblemes} onChange={(e) => set("urlProblemes", e.target.value)} placeholder="https://merchants.ubereats.com/manager/…" />
        </Field>
      </div>
      <label className="flex min-h-12 items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1 size-5" checked={f.modeAuto} onChange={(e) => set("modeAuto", e.target.checked)} />
        <span>
          <span className="font-medium">Contester automatiquement</span>
          <span className="block text-muted">Décoché : le robot relève et prépare, tu cliques « Contester avec le robot » sur chaque fiche. À cocher après un premier essai réussi.</span>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button onClick={enregistrer} disabled={busy || !f.email || (!f.motDePasse && !etat?.configure)}>Enregistrer</Button>
        {etat?.configure && (
          <Button variant="ghost" onClick={oublier} disabled={busy}>Supprimer</Button>
        )}
      </div>
      {etat?.dernierPassage && (
        <p className={`text-xs ${etat.dernierPassage.ok ? "text-muted" : "text-danger"}`}>
          Dernier passage du robot le {dateFr(etat.dernierPassage.le)} : {etat.dernierPassage.message}
        </p>
      )}
      {info && <p className="text-sm text-success">{info}</p>}
      <ErrorBox message={error} />
    </Card>
  );
}
