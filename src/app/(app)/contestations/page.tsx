"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { apiUber, RobotUber, useEtatUber, VueRobot, type DiagnosticUber, type ErreurRobot } from "@/components/UberEats";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Sheet } from "@/components/ui";
import {
  bilan,
  ETATS_UBER,
  ISSUES,
  lireCopieUber,
  messageParDefaut,
  montantSaisi,
  parMois,
  type Contestation,
  type EtatUber,
  type Issue,
  type LigneUber,
} from "@/lib/contestations";
import { formatEuros } from "@/lib/money";
import type { WithId } from "@/lib/types";

type Fiche = WithId<Contestation>;
type Filtre = "en_cours" | "terminees" | "toutes";

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
const aujourdhui = () => new Date().toISOString().slice(0, 10);
const nomMois = (m: string) =>
  new Date(`${m}-01T00:00:00Z`).toLocaleDateString("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });

function useApi() {
  const { user } = useAuth();
  const { rid } = useRestaurant();
  return useCallback(
    async (method: string, body?: unknown, query = "") => {
      if (!user) throw new Error("non connecté");
      const res = await fetch(`/api/uber-contestations?r=${rid}${query}`, {
        method,
        headers: { authorization: `Bearer ${await user.getIdToken()}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data as { error?: string }).error ?? `Erreur ${res.status}`);
      return data;
    },
    [user, rid],
  );
}

export default function ContestationsPage() {
  const api = useApi();
  const [fiches, setFiches] = useState<Fiche[]>([]);
  const [chargement, setChargement] = useState(true);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [filtre, setFiltre] = useState<Filtre>("en_cours");
  const [ouverte, setOuverte] = useState<Fiche | null>(null);
  const [collage, setCollage] = useState(false);
  const [ajout, setAjout] = useState(false);

  const [version, setVersion] = useState(0);
  const recharger = useCallback(async () => setVersion((v) => v + 1), []);
  useEffect(() => {
    let actif = true;
    api("GET")
      .then((d) => {
        if (!actif) return;
        setFiches((d as { fiches: Fiche[] }).fiches);
        setErreur(null);
      })
      .catch((e: Error) => actif && setErreur(e.message))
      .finally(() => actif && setChargement(false));
    return () => {
      actif = false;
    };
  }, [api, version]);

  const visibles = useMemo(
    () =>
      fiches.filter((f) =>
        filtre === "toutes" ? true : filtre === "en_cours" ? f.issue === "a_contester" || f.issue === "contestee" : f.issue !== "a_contester" && f.issue !== "contestee",
      ),
    [fiches, filtre],
  );
  const total = bilan(fiches);
  const enCours = fiches.filter((f) => f.issue === "a_contester" || f.issue === "contestee").length;

  async function importer(lignes: LigneUber[]) {
    const d = (await api("POST", { lignes })) as { ajoutees: number; misesAJour: number; inchangees: number };
    setInfo(`${d.ajoutees} commande(s) ajoutée(s), ${d.misesAJour} mise(s) à jour, ${d.inchangees} déjà suivie(s).`);
    await recharger();
  }

  return (
    <div>
      <PageHeader
        title="Contestations Uber"
        action={
          <>
            <Button variant="secondary" onClick={() => setAjout(true)}>+ Une commande</Button>
            <Button onClick={() => setCollage(true)}>Coller depuis Uber Eats</Button>
          </>
        }
      />
      <p className="mb-4 text-sm text-muted">
        Suivi des erreurs de commande signalées par les clients. Seules les commandes marquées « Problème facturé » ou « Remboursement effectué par Uber » sont mises à contester.
      </p>
      <RobotUber onFini={recharger} />

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi titre="Retenu par Uber" valeur={formatEuros(total.retenu)} sous={total.sansMontant ? `${total.sansMontant} sans montant` : `${total.nombre} commande(s)`} />
        <Kpi titre="Récupéré" valeur={formatEuros(total.recupere)} ton="text-success" />
        <Kpi titre="En attente" valeur={formatEuros(total.enAttente)} sous={`${enCours} en cours`} />
        <Kpi titre="Perdu" valeur={formatEuros(total.perdu)} ton="text-danger" />
      </div>

      <div className="mb-4 flex flex-wrap gap-2">
        {(["en_cours", "terminees", "toutes"] as Filtre[]).map((f) => (
          <Button key={f} variant={filtre === f ? "primary" : "secondary"} onClick={() => setFiltre(f)}>
            {{ en_cours: "En cours", terminees: "Terminées", toutes: `Toutes (${fiches.length})` }[f]}
          </Button>
        ))}
      </div>

      <ErrorBox message={erreur} />
      {info && <p className="mb-3 rounded-control bg-success-soft p-3 text-sm text-success">{info}</p>}
      {chargement ? (
        <p className="text-muted">Chargement…</p>
      ) : visibles.length === 0 ? (
        <Empty>
          {fiches.length === 0
            ? "Aucune contestation suivie. Dans Uber Eats Manager, sélectionnez les lignes du tableau des problèmes, copiez-les, puis « Coller depuis Uber Eats »."
            : "Rien dans cette liste."}
        </Empty>
      ) : (
        <div className="space-y-6">
          {parMois(visibles).map(([mois, liste]) => {
            const b = bilan(liste);
            return (
              <section key={mois}>
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="font-semibold capitalize">{nomMois(mois)}</h2>
                  <span className="text-sm text-muted">
                    retenu {formatEuros(b.retenu)} · récupéré {formatEuros(b.recupere)} · perdu {formatEuros(b.perdu)}
                  </span>
                </div>
                <ul className="grid gap-3 lg:grid-cols-2">
                  {liste.map((f) => (
                    <li key={f.id}>
                      <button className="block w-full text-left" onClick={() => setOuverte(f)}>
                        <Card className="space-y-2 hover:border-ink">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold">
                                {f.commande} <span className="font-normal text-muted">· {fr(f.dateCommande)}{f.heure ? ` ${f.heure}` : ""}</span>
                              </div>
                              <div className="truncate text-sm text-muted">{f.motif || "Motif ?"}{f.client ? ` · ${f.client}` : ""}</div>
                            </div>
                            <Badge tone={ISSUES[f.issue].tone}>{ISSUES[f.issue].label}</Badge>
                          </div>
                          <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                            <span className="text-danger">{ETATS_UBER[f.etatUber]}</span>
                            <span>{f.montant !== undefined ? `retenu ${formatEuros(f.montant)}` : <span className="text-warning">montant ?</span>}</span>
                            {f.dateContestation && <span className="text-muted">contestée le {fr(f.dateContestation)}</span>}
                            {f.dateVersement && <span className="text-success">versé le {fr(f.dateVersement)}</span>}
                            {f.erreurRobot && f.issue === "a_contester" && <span className="text-warning">robot : échec</span>}
                          </div>
                        </Card>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}

      <Sheet open={ouverte !== null} onClose={() => setOuverte(null)} title={`Commande ${ouverte?.commande ?? ""}`}>
        {ouverte && (
          <SuiviForm
            fiche={ouverte}
            onDone={async () => {
              setOuverte(null);
              await recharger();
            }}
          />
        )}
      </Sheet>
      <Sheet open={collage} onClose={() => setCollage(false)} title="Coller depuis Uber Eats Manager">
        {collage && <CollageForm onImport={importer} onDone={() => setCollage(false)} />}
      </Sheet>
      <Sheet open={ajout} onClose={() => setAjout(false)} title="Ajouter une commande">
        {ajout && <AjoutForm onImport={importer} onDone={() => setAjout(false)} />}
      </Sheet>
    </div>
  );
}

function Kpi({ titre, valeur, sous, ton = "" }: { titre: string; valeur: string; sous?: string; ton?: string }) {
  return (
    <Card>
      <div className="text-sm text-muted">{titre}</div>
      <div className={`mt-1 font-display text-kpi ${ton}`}>{valeur}</div>
      {sous && <div className="text-sm text-muted">{sous}</div>}
    </Card>
  );
}

function CollageForm({ onImport, onDone }: { onImport: (l: LigneUber[]) => Promise<void>; onDone: () => void }) {
  const [texte, setTexte] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const lignes = useMemo(() => lireCopieUber(texte), [texte]);

  async function valider() {
    setEnvoi(true);
    try {
      await onImport(lignes);
      onDone();
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Dans Uber Eats Manager, ouvrez la liste des commandes avec un problème, sélectionnez le tableau à la souris (de l&apos;identifiant de la première commande jusqu&apos;à la dernière ligne), copiez, puis collez ici.
      </p>
      <textarea
        className="min-h-40 w-full rounded-control border border-border bg-surface p-3 text-base outline-none focus:border-ink"
        value={texte}
        onChange={(e) => setTexte(e.target.value)}
        placeholder="57FF6	Tib's (K)	04/11/2026	18:52	Johny S	…"
      />
      {texte && (
        <ul className="space-y-2">
          {lignes.length === 0 && <li className="text-sm text-warning">Aucune commande reconnue dans ce texte.</li>}
          {lignes.map((l) => (
            <li key={`${l.commande}${l.dateCommande}`} className="flex items-center justify-between gap-2 rounded-control border border-border p-2 text-sm">
              <span className="min-w-0 truncate">
                {l.commande} · {fr(l.dateCommande)} · {l.motif || "motif ?"}
              </span>
              {l.etatUber === "probleme_facture" || l.etatUber === "rembourse_uber" ? <Badge tone="orange">À contester</Badge> : <Badge>{ETATS_UBER[l.etatUber]}</Badge>}
            </li>
          ))}
        </ul>
      )}
      <ErrorBox message={erreur} />
      <Button className="w-full" disabled={!lignes.length || envoi} onClick={valider}>
        {envoi ? "Enregistrement…" : `Suivre ${lignes.length} commande(s)`}
      </Button>
    </div>
  );
}

function AjoutForm({ onImport, onDone }: { onImport: (l: LigneUber[]) => Promise<void>; onDone: () => void }) {
  const [commande, setCommande] = useState("");
  const [date, setDate] = useState(aujourdhui());
  const [motif, setMotif] = useState("");
  const [etat, setEtat] = useState<EtatUber>("probleme_facture");
  const [erreur, setErreur] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await onImport([{ commande: commande.trim().toUpperCase(), dateCommande: date, motif: motif.trim(), etatUber: etat, justificatif: false }]);
      onDone();
    } catch (err) {
      setErreur((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Identifiant de la commande"><Input required value={commande} onChange={(e) => setCommande(e.target.value)} placeholder="57FF6" /></Field>
      <Field label="Date de la commande"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <Field label="Motif du client"><Input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Mauvaise commande reçue" /></Field>
      <Field label="Indiqué par Uber">
        <Select value={etat} onChange={(e) => setEtat(e.target.value as EtatUber)}>
          {Object.entries(ETATS_UBER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
      </Field>
      <ErrorBox message={erreur} />
      <Button type="submit" className="w-full">Ajouter</Button>
    </form>
  );
}

function SuiviForm({ fiche, onDone }: { fiche: Fiche; onDone: () => Promise<void> }) {
  const api = useApi();
  const { user } = useAuth();
  const { rid } = useRestaurant();
  const { etat: robot } = useEtatUber();
  const [robotBusy, setRobotBusy] = useState<"essai" | "envoi" | null>(null);
  const [vue, setVue] = useState<DiagnosticUber | undefined>(undefined);
  const [robotInfo, setRobotInfo] = useState<string | null>(null);
  const [f, setF] = useState({
    motif: fiche.motif,
    etatUber: fiche.etatUber,
    montant: fiche.montant !== undefined ? (fiche.montant / 100).toFixed(2).replace(".", ",") : "",
    dateReclamation: fiche.dateReclamation ?? "",
    dateContestation: fiche.dateContestation ?? "",
    commentaire: fiche.commentaire ?? messageParDefaut(fiche.motif),
    issue: fiche.issue,
    dateReponse: fiche.dateReponse ?? "",
    montantRecupere: fiche.montantRecupere !== undefined ? (fiche.montantRecupere / 100).toFixed(2).replace(".", ",") : "",
    dateVersement: fiche.dateVersement ?? "",
    note: fiche.note ?? "",
  });
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const [copie, setCopie] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  async function enregistrer(e?: FormEvent, surcharge: Partial<typeof f> = {}) {
    e?.preventDefault();
    const v = { ...f, ...surcharge };
    setEnvoi(true);
    try {
      await api("PATCH", {
        id: fiche.id,
        champs: {
          motif: v.motif,
          etatUber: v.etatUber,
          montant: montantSaisi(v.montant) ?? null,
          dateReclamation: v.dateReclamation || null,
          dateContestation: v.dateContestation || null,
          commentaire: v.commentaire,
          issue: v.issue,
          dateReponse: v.dateReponse || null,
          montantRecupere: montantSaisi(v.montantRecupere) ?? null,
          dateVersement: v.dateVersement || null,
          note: v.note,
        },
      });
      await onDone();
    } catch (err) {
      setErreur((err as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  /** Le robot utilise le message enregistré : on l'enregistre d'abord, puis il ouvre la commande dans Uber Eats Manager. */
  async function parRobot(essai: boolean) {
    if (!user) return;
    setRobotBusy(essai ? "essai" : "envoi");
    setErreur(null);
    setRobotInfo(null);
    setVue(undefined);
    try {
      await api("PATCH", { id: fiche.id, champs: { commentaire: f.commentaire } });
      const r = await apiUber<{ envoyee: boolean; montant: number | null; diagnostic?: DiagnosticUber }>(user, `/api/uber-eats/contester?r=${rid}`, {
        method: "POST",
        body: JSON.stringify({ id: fiche.id, essai }),
      });
      setVue(r.diagnostic);
      if (essai) {
        setRobotInfo(`Essai réussi : le formulaire est rempli mais rien n'a été envoyé${r.montant ? `. Montant lu : ${formatEuros(r.montant)}` : ""}. Vérifie la capture.`);
      } else if (r.envoyee) {
        await onDone();
      } else {
        setErreur("Le robot a cliqué sur Envoyer mais Uber n'a pas confirmé. Vérifie la capture, et dans Uber Eats Manager.");
      }
    } catch (e) {
      setErreur((e as Error).message);
      setVue((e as ErreurRobot).diagnostic);
    } finally {
      setRobotBusy(null);
    }
  }

  async function copier() {
    try {
      await navigator.clipboard.writeText(f.commentaire);
      setCopie(true);
    } catch {
      alert(f.commentaire);
    }
  }

  async function supprimer() {
    if (!confirm(`Ne plus suivre la commande ${fiche.commande} ?`)) return;
    try {
      await api("DELETE", undefined, `&id=${encodeURIComponent(fiche.id)}`);
      await onDone();
    } catch (err) {
      setErreur((err as Error).message);
    }
  }

  return (
    <form onSubmit={enregistrer} className="space-y-4">
      <p className="text-sm text-muted">
        Commande du {fr(fiche.dateCommande)}{fiche.heure ? ` à ${fiche.heure}` : ""}{fiche.client ? ` · ${fiche.client}` : ""}
        {fiche.justificatif ? " · photo jointe par le client" : ""}
      </p>

      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Motif du client"><Input value={f.motif} onChange={(e) => set("motif", e.target.value)} /></Field>
        <Field label="Indiqué par Uber">
          <Select value={f.etatUber} onChange={(e) => set("etatUber", e.target.value as EtatUber)}>
            {Object.entries(ETATS_UBER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Réclamation du client le"><Input type="date" value={f.dateReclamation} onChange={(e) => set("dateReclamation", e.target.value)} /></Field>
        <Field label="Montant retenu (€)" hint="Visible dans le détail de la commande ou sur le relevé Uber">
          <Input inputMode="decimal" value={f.montant} onChange={(e) => set("montant", e.target.value)} placeholder="0,00" />
        </Field>
      </div>

      <Field label="Message de contestation">
        <textarea
          className="min-h-32 w-full rounded-control border border-border bg-surface p-3 text-base outline-none focus:border-ink"
          value={f.commentaire}
          onChange={(e) => set("commentaire", e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Button type="button" variant="secondary" onClick={copier}>{copie ? "Message copié" : "Copier le message"}</Button>
        {f.issue === "a_contester" && (
          <Button type="button" disabled={envoi} onClick={() => enregistrer(undefined, { issue: "contestee", dateContestation: f.dateContestation || aujourdhui() })}>
            Contestée aujourd&apos;hui
          </Button>
        )}
      </div>
      {f.issue === "a_contester" && robot?.configure && (
        <div className="space-y-2 rounded-control bg-surface-2 p-3">
          <p className="text-sm font-medium">Robot Uber Eats</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button type="button" variant="secondary" disabled={robotBusy !== null} onClick={() => parRobot(true)}>
              {robotBusy === "essai" ? "Essai en cours…" : "Essai sans envoyer"}
            </Button>
            <Button type="button" disabled={robotBusy !== null} onClick={() => confirm(`Envoyer la contestation de ${fiche.commande} à Uber ?`) && parRobot(false)}>
              {robotBusy === "envoi" ? "Envoi en cours…" : "Contester avec le robot"}
            </Button>
          </div>
          {fiche.erreurRobot && !robotInfo && !erreur && (
            <p className="text-xs text-warning">Dernier échec le {new Date(fiche.erreurRobot.le).toLocaleString("fr-FR")} : {fiche.erreurRobot.message}</p>
          )}
          {robotInfo && <p className="text-sm text-success">{robotInfo}</p>}
          <VueRobot d={vue} />
        </div>
      )}

      <div className="grid items-end gap-3 sm:grid-cols-2">
        <Field label="Suivi">
          <Select value={f.issue} onChange={(e) => set("issue", e.target.value as Issue)}>
            {Object.entries(ISSUES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </Select>
        </Field>
        <Field label="Contestée le"><Input type="date" value={f.dateContestation} onChange={(e) => set("dateContestation", e.target.value)} /></Field>
        <Field label="Réponse d'Uber le"><Input type="date" value={f.dateReponse} onChange={(e) => set("dateReponse", e.target.value)} /></Field>
        <Field label="Montant récupéré (€)" hint="Vide = tout le montant retenu si acceptée">
          <Input inputMode="decimal" value={f.montantRecupere} onChange={(e) => set("montantRecupere", e.target.value)} placeholder="0,00" />
        </Field>
        <Field label="Versé par Uber le" hint="Date du versement qui contient le remboursement">
          <Input type="date" value={f.dateVersement} onChange={(e) => set("dateVersement", e.target.value)} />
        </Field>
        <Field label="Note"><Input value={f.note} onChange={(e) => set("note", e.target.value)} /></Field>
      </div>

      <ErrorBox message={erreur} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="danger" onClick={supprimer}>Ne plus suivre</Button>
        <Button type="submit" disabled={envoi}>{envoi ? "Enregistrement…" : "Enregistrer"}</Button>
      </div>
    </form>
  );
}
