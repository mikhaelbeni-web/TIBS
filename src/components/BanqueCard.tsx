"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, ErrorBox, Field, Select } from "@/components/ui";
import { joursRestants } from "@/lib/banque";
import { db } from "@/lib/firebase";
import { isRestaurantId } from "@/lib/restaurants";

type User = { getIdToken: () => Promise<string> };

async function api<T>(user: User, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json", ...init.headers },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `Erreur ${res.status}`);
  return json as T;
}

interface EtatBanque {
  banque?: string;
  comptes?: { uid: string; nom: string; iban: string }[];
  validUntil?: string;
  connecteLe?: number;
  dernierPassage?: number;
  dernierResultat?: { nouvelles: number; le: number };
  derniereOperation?: string;
  erreur?: string;
  expiree?: boolean;
}

const RETOURS: Record<string, string> = {
  ok: "Banque connectée. Les opérations des 90 derniers jours ont été relevées.",
  refuse: "Connexion annulée ou refusée à la banque.",
  lien_expire: "Le lien de connexion a expiré : recommence.",
  aucun_compte: "La banque n'a partagé aucun compte. Recommence et coche le ou les comptes du restaurant.",
  erreur: "La connexion à la banque a échoué. Recommence dans quelques minutes.",
};

const dateHeure = (ms: number) => new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" });
const dateFr = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { dateStyle: "long" });

export function BanqueCard() {
  return (
    <Suspense>
      <BanqueCardInner />
    </Suspense>
  );
}

/** Carte « Banque » : accès DSP2 en lecture seule, relevé automatique quotidien des opérations. */
function BanqueCardInner() {
  const { rid, current, setRid } = useRestaurant();
  const { user } = useAuth();
  const params = useSearchParams();
  const retour = params.get("banque");
  const retourRid = params.get("r");
  useEffect(() => {
    if (isRestaurantId(retourRid) && retourRid !== rid) setRid(retourRid);
  }, [retourRid, rid, setRid]);

  const [etat, setEtat] = useState<EtatBanque | null>(null);
  const [liste, setListe] = useState<{ name: string; psuTypes: string[] }[] | null>(null);
  const [configuree, setConfiguree] = useState<boolean | null>(null);
  const [banque, setBanque] = useState("");
  const [psuType, setPsuType] = useState<"business" | "personal">("business");
  const [ouvert, setOuvert] = useState(false);
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(retour ? RETOURS[retour] ?? null : null);

  useEffect(
    () => onSnapshot(doc(db(), "restaurants", rid, "settings", "banque"), (s) => setEtat((s.data() as EtatBanque) ?? {}), (e) => setError(e.message)),
    [rid],
  );

  const connectee = Boolean(etat?.connecteLe);
  const besoinListe = ouvert || (etat !== null && !connectee);

  useEffect(() => {
    if (!user || !besoinListe || liste) return;
    api<{ configuree: boolean; banques: { name: string; psuTypes: string[] }[] }>(user, "/api/banque/banques")
      .then((r) => {
        setConfiguree(r.configuree);
        setListe(r.banques);
        if (r.banques[0]) setBanque((b) => b || r.banques[0].name);
      })
      .catch((e) => setError(e.message));
  }, [user, besoinListe, liste]);

  async function run(kind: "connect" | "sync" | "disconnect") {
    if (!user) return;
    if (kind === "disconnect" && !confirm(`Déconnecter la banque de ${current.court} ? Les opérations déjà relevées sont gardées.`)) return;
    setBusy(kind);
    setError(null);
    setInfo(null);
    try {
      if (kind === "connect") {
        const { url } = await api<{ url: string }>(user, `/api/banque/connect?r=${rid}`, { method: "POST", body: JSON.stringify({ banque, psuType }) });
        window.location.assign(url);
        return;
      }
      if (kind === "sync") {
        const r = await api<{ nouvelles: number }>(user, `/api/banque/sync?r=${rid}`, { method: "POST" });
        setInfo(r.nouvelles ? `${r.nouvelles} nouvelle(s) opération(s).` : "Aucune nouvelle opération.");
      } else {
        await api(user, `/api/banque/disconnect?r=${rid}`, { method: "POST" });
        setOuvert(false);
      }
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(null);
  }

  const reste = joursRestants(etat?.validUntil);
  const aRenouveler = etat?.expiree || (reste !== null && reste <= 14);
  const choisie = liste?.find((b) => b.name === banque);
  const proPossible = !choisie || choisie.psuTypes.length === 0 || choisie.psuTypes.includes("business");
  const persoPossible = !choisie || choisie.psuTypes.length === 0 || choisie.psuTypes.includes("personal");

  const formulaire = (
    <div className="space-y-3">
      {configuree === false ? (
        <p className="rounded-control bg-warning-soft p-3 text-sm text-warning">
          L&rsquo;accès bancaire n&rsquo;est pas encore activé sur le serveur (clé Enable Banking à ajouter dans Vercel).
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Banque">
              <Select value={banque} onChange={(e) => setBanque(e.target.value)} disabled={!liste?.length}>
                {!liste && <option>Chargement…</option>}
                {liste?.map((b) => (
                  <option key={b.name} value={b.name}>{b.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Type de compte">
              <Select value={psuType} onChange={(e) => setPsuType(e.target.value as "business" | "personal")}>
                {proPossible && <option value="business">Professionnel</option>}
                {persoPossible && <option value="personal">Particulier</option>}
              </Select>
            </Field>
          </div>
          <p className="text-xs text-muted">
            Tu seras envoyé sur le site de ta banque pour t&rsquo;identifier et valider sur ton téléphone. L&rsquo;app ne voit jamais ton mot de passe et
            n&rsquo;a qu&rsquo;un accès en lecture (opérations), valable 180 jours.
          </p>
          <Button onClick={() => run("connect")} disabled={busy !== null || !banque || !liste?.length} className="w-full sm:w-auto">
            {busy === "connect" ? "Ouverture de la banque…" : connectee ? "Renouveler l'accès" : "Connecter la banque"}
          </Button>
        </>
      )}
    </div>
  );

  return (
    <Card className="mb-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold">Banque · {current.court}</h2>
        {etat !== null && (
          <Badge tone={!connectee ? "neutral" : etat.erreur || aRenouveler ? "orange" : "green"}>
            {!connectee ? "Non connectée" : etat.expiree ? "Accès expiré" : etat.erreur ? "Erreur" : "Relevé automatique"}
          </Badge>
        )}
      </div>

      {connectee ? (
        <>
          <div className="text-sm">
            <div className="font-medium">{etat?.banque}</div>
            <ul className="text-muted">
              {etat?.comptes?.map((c) => (
                <li key={c.uid} className="truncate">{c.nom}{c.iban ? ` · ${c.iban}` : ""}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-muted">
            {etat?.dernierPassage ? `Dernier relevé : ${dateHeure(etat.dernierPassage)}` : "Pas encore relevé"}
            {etat?.dernierResultat ? ` (${etat.dernierResultat.nouvelles} nouvelle(s))` : ""}. Relevé automatique plusieurs fois par jour.
            {etat?.validUntil ? ` Accès valable jusqu'au ${dateFr(etat.validUntil)}.` : ""}
          </p>
          {aRenouveler && (
            <p className="rounded-control bg-warning-soft p-3 text-sm text-warning">
              {etat?.expiree || (reste !== null && reste < 0)
                ? "L'accès à la banque a expiré : renouvelle-le pour reprendre le relevé automatique."
                : `L'accès à la banque expire dans ${reste} jour(s) : renouvelle-le (une validation sur ton téléphone).`}
            </p>
          )}
          {etat?.erreur && !etat.expiree && <ErrorBox message={etat.erreur} />}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => run("sync")} disabled={busy !== null}>{busy === "sync" ? "Relevé…" : "Relever maintenant"}</Button>
            <Button variant={aRenouveler ? "primary" : "secondary"} onClick={() => setOuvert((o) => !o)} disabled={busy !== null}>
              Renouveler l&rsquo;accès
            </Button>
            <Button variant="ghost" onClick={() => run("disconnect")} disabled={busy !== null}>Déconnecter</Button>
          </div>
          {ouvert && formulaire}
        </>
      ) : etat !== null ? (
        <>
          <p className="text-sm text-muted">
            Connecte le compte bancaire de {current.nom} : l&rsquo;app relèvera les opérations chaque jour, sans import de fichier, pour le pointage
            CB, espèces, Uber et prélèvements.
          </p>
          {formulaire}
        </>
      ) : null}

      {info && <p className="text-sm text-success">{info}</p>}
      <ErrorBox message={error} />
    </Card>
  );
}
