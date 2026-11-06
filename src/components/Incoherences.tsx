"use client";

import Link from "next/link";
import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, ErrorBox } from "@/components/ui";
import { db } from "@/lib/firebase";
import type { BilanIncoherences, TypeIncoherence } from "@/lib/incoherences";

type Doc = BilanIncoherences & { total?: number };

const fr = (iso: string) => iso.split("-").reverse().join("/");

const ETIQUETTES: Record<TypeIncoherence, string> = {
  cb: "CB",
  cb_sans_remise: "CB",
  remise_sans_caisse: "CB",
  total_z: "Ticket Z",
  uber_jour: "Uber",
  uber_semaine: "Uber",
  uber_banque: "Uber",
  titres: "Tickets-resto",
};

/** Lit settings/incoherences (un seul document, recalculé par le serveur après chaque relevé). */
export function useIncoherences(): Doc | null | undefined {
  const { rid } = useRestaurant();
  const [d, setD] = useState<Doc | null | undefined>(undefined);
  useEffect(
    () =>
      onSnapshot(
        doc(db(), "restaurants", rid, "settings", "incoherences"),
        (s) => setD(s.exists() ? (s.data() as Doc) : null),
        () => setD(null),
      ),
    [rid],
  );
  return d;
}

/** Liste « À regarder » de l'accueil : chaque incohérence ouvre la journée concernée dans Caisse > Jour à jour. */
export function ListeIncoherences({ data }: { data: Doc | null | undefined }) {
  const { user } = useAuth();
  const { rid } = useRestaurant();
  const [calcul, setCalcul] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [tout, setTout] = useState(false);

  async function recalculer() {
    if (!user) return;
    setErreur(null);
    setCalcul(true);
    try {
      const res = await fetch(`/api/incoherences?r=${rid}`, { method: "POST", headers: { authorization: `Bearer ${await user.getIdToken()}` } });
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(b.error ?? `Erreur ${res.status}`);
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setCalcul(false);
    }
  }

  const liste = data?.liste ?? [];
  const total = data?.total ?? liste.length;
  const visibles = tout ? liste : liste.slice(0, 8);
  return (
    <section className="mb-6 space-y-3" aria-labelledby="titre-incoherences">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="titre-incoherences" className="font-display text-lg font-semibold">
          À regarder {total ? <span className="text-danger">({total})</span> : null}
        </h2>
        <Button variant="secondary" onClick={recalculer} disabled={calcul || !user}>
          {calcul ? "Calcul…" : "Recalculer"}
        </Button>
      </div>
      <ErrorBox message={erreur} />
      {data === undefined ? (
        <p className="text-sm text-muted">Chargement…</p>
      ) : !data ? (
        <Card>
          <p className="text-sm text-muted">Pas encore de contrôle. Appuie sur « Recalculer » pour lancer le premier.</p>
        </Card>
      ) : !liste.length ? (
        <Card>
          <p className="text-sm font-medium text-success">Aucune incohérence entre caisse, banque et Uber Eats.</p>
          <p className="mt-1 text-xs text-muted">
            Du {fr(data.depuis)} au {fr(data.jusqua)} · contrôlé le {new Date(data.le).toLocaleString("fr-FR")}
          </p>
        </Card>
      ) : (
        <>
          <ul className="space-y-2">
            {visibles.map((x) => (
              <li key={x.cle}>
                <Link href={x.jour ? `/rapprochement?jour=${x.jour}` : "/rapprochement"} className="block">
                  <Card className="border-danger/40 hover:border-danger">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-medium">{x.titre}</div>
                        <p className="mt-0.5 break-words text-sm text-muted">{x.detail}</p>
                      </div>
                      <Badge tone="red">{ETIQUETTES[x.type] ?? "Écart"}</Badge>
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
          {liste.length > 8 && (
            <Button variant="secondary" onClick={() => setTout(!tout)}>
              {tout ? "Voir moins" : `Voir les ${liste.length} incohérences`}
            </Button>
          )}
          {total > liste.length && <p className="text-xs text-muted">Les {liste.length} plus récentes sur {total}.</p>}
          <p className="text-xs text-muted">
            Du {fr(data.depuis)} au {fr(data.jusqua)} · contrôlé le {new Date(data.le).toLocaleString("fr-FR")}
          </p>
        </>
      )}
      {Boolean(data?.attente?.length) && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted">{data!.attente.length} en attente (peut encore se régler tout seul)</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-muted">
            {data!.attente.map((a) => (
              <li key={a.cle}>{a.titre}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
