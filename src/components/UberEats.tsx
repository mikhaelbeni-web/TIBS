"use client";

import { doc, onSnapshot, setDoc } from "firebase/firestore";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { db } from "@/lib/firebase";
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
  journal?: string[];
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
  avecMotDePasse?: boolean;
  email: string;
  telephone?: string;
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
      {Boolean(d.journal?.length) && (
        <ol className="mt-2 space-y-1 text-xs text-muted">
          {d.journal!.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      )}
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
      <ConnexionUber />
    </Card>
  );
}

/** Réglages : identifiants Uber Eats Manager du restaurant (envoyés au serveur, mot de passe chiffré, jamais relu). */
export function UberEatsIdentifiants() {
  const { rid, current } = useRestaurant();
  const { user } = useAuth();
  const { etat, recharger } = useEtatUber();
  const [f, setF] = useState({ email: "", motDePasse: "", telephone: "", boutique: "", urlProblemes: "", modeAuto: false });
  const [charge, setCharge] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (etat && !charge) {
    setCharge(true);
    setF({ email: etat.email, motDePasse: "", telephone: etat.telephone ?? "", boutique: etat.boutique, urlProblemes: etat.urlProblemes, modeAuto: etat.modeAuto });
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

  async function effacerMdp() {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await apiUber(user, `/api/uber-eats/identifiants?r=${rid}`, { method: "POST", body: JSON.stringify({ ...f, motDePasse: "", sansMotDePasse: true }) });
      setInfo("Mot de passe effacé : le robot se connectera par code.");
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
      setF({ email: "", motDePasse: "", telephone: "", boutique: "", urlProblemes: "", modeAuto: false });
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
        Le robot se connecte à Uber Eats Manager pour {current.nom}, relève les commandes avec un problème et conteste celles marquées « Problème facturé » ou « Remboursement effectué par Uber ». Quand tu le lances depuis la page Contestations, tu suis la connexion en direct (ce que le robot voit, étape par étape) et tu y tapes le code envoyé par Uber ; ensuite la session est gardée, le code n&rsquo;est redemandé que rarement.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="E-mail du compte Uber Eats">
          <Input autoComplete="off" inputMode="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Téléphone du compte Uber" hint="Uber le demande après l'e-mail, puis envoie le code par SMS : le robot le tape tout seul.">
          <Input type="tel" autoComplete="off" inputMode="tel" value={f.telephone} onChange={(e) => set("telephone", e.target.value)} placeholder="06 12 34 56 78" />
        </Field>
        <Field label="Mot de passe (facultatif)" hint="Laisse vide si Uber se connecte par code reçu par mail ou SMS.">
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
        <Button onClick={enregistrer} disabled={busy || !f.email}>Enregistrer</Button>
        {etat?.avecMotDePasse && (
          <Button variant="ghost" onClick={effacerMdp} disabled={busy}>Effacer le mot de passe enregistré</Button>
        )}
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

interface ConnexionLive {
  actif?: boolean;
  interactif?: boolean;
  debut?: number;
  maj?: number;
  etape?: string;
  journal?: string[];
  capture?: string;
  code?: string;
  attenteCode?: { canal: string; depuis: number; jusqua?: number } | null;
  fin?: { ok: boolean; le: number; message: string };
}

/** Au-delà, une connexion « active » sans nouvelles est considérée comme coupée (fonction serveur arrêtée). */
const PERIME = 5 * 60_000;

/**
 * Connexion du robot à Uber Eats, en direct : étape en cours, capture d'écran de ce qu'il voit, journal,
 * et une case toujours disponible pour taper le code reçu d'Uber (settings/uberConnexion, champ code).
 * S'affiche en grand dès qu'une connexion démarre ; ensuite, une ligne permet de revoir la dernière.
 */
export function ConnexionUber() {
  const { rid } = useRestaurant();
  const [c, setC] = useState<ConnexionLive | null>(null);
  const [maintenant, setMaintenant] = useState(() => Date.now());
  const [vu, setVu] = useState<number | null>(null); // connexion vue en cours : on la garde affichée jusqu'à « Fermer »
  const [ouvert, setOuvert] = useState(false);
  const [reduit, setReduit] = useState(false);
  const [code, setCode] = useState("");
  const [envoyeLe, setEnvoyeLe] = useState(0);
  const [erreur, setErreur] = useState<string | null>(null);

  useEffect(
    () =>
      onSnapshot(
        doc(db(), "restaurants", rid, "settings", "uberConnexion"),
        (s) => setC((s.data() as ConnexionLive | undefined) ?? null),
        () => {},
      ),
    [rid],
  );
  useEffect(() => {
    const t = setInterval(() => setMaintenant(Date.now()), 2_000);
    return () => clearInterval(t);
  }, []);

  const enCours = Boolean(c?.actif && c.maj && maintenant - c.maj < PERIME);
  if (enCours && c?.debut && vu !== c.debut) {
    // Nouvelle connexion : on l'affiche en grand et on remet la case du code à zéro.
    setVu(c.debut);
    setOuvert(true);
    setReduit(false);
    setCode("");
    setEnvoyeLe(0);
    setErreur(null);
  }
  if (!c?.debut) return null;

  async function envoyer() {
    setErreur(null);
    try {
      await setDoc(doc(db(), "restaurants", rid, "settings", "uberConnexion"), { code: code.trim() }, { merge: true });
      setEnvoyeLe(Date.now());
      setCode("");
    } catch (e) {
      setErreur((e as Error).message);
    }
  }

  const attente = enCours ? c.attenteCode : null;
  const resteS = attente?.jusqua ? Math.max(0, Math.round((attente.jusqua - maintenant) / 1000)) : null;
  const ou = attente?.canal === "sms" ? "par SMS" : attente?.canal === "mail" ? "par mail" : "";
  // La case revient si Uber redemande un code après celui déjà transmis.
  const saisie = !c.code && (!envoyeLe || Boolean(attente && attente.depuis > envoyeLe));
  const statut = enCours ? (
    <Badge tone="info">En cours</Badge>
  ) : c.fin?.ok ? (
    <Badge tone="green">Réussie</Badge>
  ) : c.fin ? (
    <Badge tone="red">Échec</Badge>
  ) : (
    <Badge tone="orange">Interrompue</Badge>
  );
  const resume = enCours ? c.etape : (c.fin?.message ?? "Connexion coupée avant la fin (délai du serveur dépassé).");

  if (!ouvert) {
    return (
      <button type="button" onClick={() => setOuvert(true)} className="flex min-h-11 w-full items-center gap-2 text-left text-sm">
        {statut}
        <span className="min-w-0 flex-1 truncate text-muted">
          Dernière connexion à Uber le {dateFr(c.debut)} : {resume}
        </span>
        <span className="shrink-0 font-medium underline">Voir</span>
      </button>
    );
  }

  if (reduit) {
    return (
      <button
        type="button"
        onClick={() => setReduit(false)}
        className={`fixed inset-x-4 bottom-20 z-[60] mx-auto flex min-h-12 max-w-md items-center gap-2 rounded-full border-2 bg-surface px-4 text-left text-sm shadow-sheet md:bottom-6 ${attente ? "border-primary" : "border-border"}`}
      >
        {statut}
        <span className="min-w-0 flex-1 truncate">{attente ? "Uber attend le code : touche pour le taper" : resume}</span>
      </button>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-[60] mx-auto max-h-[88dvh] w-full max-w-lg overflow-y-auto rounded-t-card border border-border bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-sheet sm:bottom-6 sm:rounded-card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="font-semibold">Connexion à Uber Eats</h2>
          {statut}
        </div>
        {enCours ? (
          <Button variant="ghost" onClick={() => setReduit(true)}>Réduire</Button>
        ) : (
          <Button variant="ghost" onClick={() => setOuvert(false)}>Fermer</Button>
        )}
      </div>

      <p className={`text-sm ${!enCours && !c.fin?.ok ? "text-danger" : ""}`}>
        {enCours && <span className="mr-2 inline-block size-2 animate-pulse rounded-full bg-primary align-middle" />}
        {resume}
      </p>

      {enCours && c.interactif && (
        <div className={`mt-3 rounded-control border-2 p-3 ${attente ? "border-primary" : "border-border"}`}>
          <p className="text-sm font-semibold">{attente ? `Uber attend le code envoyé ${ou || "au titulaire du compte"}` : "Code reçu d'Uber"}</p>
          <p className="mb-2 text-xs text-muted">
            {attente
              ? `Tape-le ici${resteS !== null ? ` : il reste ${resteS} s` : ""}.`
              : "Dès qu'un code arrive (mail ou SMS du compte Uber), tape-le ici : le robot l'utilisera."}
          </p>
          {saisie ? (
            <div className="flex gap-2">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus={Boolean(attente)}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))}
                placeholder="Code"
              />
              <Button onClick={envoyer} disabled={code.length < 4}>Envoyer</Button>
            </div>
          ) : (
            <p className="text-sm text-success">{c.code ? "Code transmis, le robot va le prendre…" : "Code transmis au robot, il continue…"}</p>
          )}
          <ErrorBox message={erreur} />
        </div>
      )}

      {c.capture && (
        <figure className="mt-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`data:image/jpeg;base64,${c.capture}`} alt="Ce que le robot voit dans Uber" className="w-full rounded-control border border-border" />
          <figcaption className="mt-1 text-xs text-muted">Ce que le robot voit{enCours ? " en ce moment" : " à la fin"}</figcaption>
        </figure>
      )}

      {Boolean(c.journal?.length) && (
        <details className="mt-3 text-sm" open={!enCours && !c.fin?.ok}>
          <summary className="cursor-pointer font-medium">Étapes ({c.journal!.length})</summary>
          <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto break-words text-xs text-muted">
            {c.journal!.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
