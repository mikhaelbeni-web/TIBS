"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { ErrorBox } from "@/components/ui";

/** Aperçu du PDF joint, récupéré à la demande depuis Gmail (rien n'est stocké). */
export function PdfApercu({ requete, nom }: { requete: string; nom: string }) {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  async function voir() {
    if (open) return setOpen(false);
    setOpen(true);
    if (url || !user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gmail/pdf?r=${rid}&${requete}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await user.getIdToken()}` },
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Erreur ${res.status}`;
        try {
          msg = JSON.parse(text).error || msg;
        } catch {}
        throw new Error(msg);
      }
      setUrl(URL.createObjectURL(await res.blob()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={voir} className="font-medium text-ink underline">
        {open ? `Masquer ${nom}` : `Voir ${nom}`}
      </button>
      {open && (
        <div className="order-last mt-2 basis-full space-y-2">
          {busy && <p className="text-sm text-muted">Chargement du PDF…</p>}
          <ErrorBox message={error} />
          {url && (
            <>
              <iframe src={url} title="Facture PDF" className="h-[60dvh] w-full rounded-control border border-border bg-white" />
              <a href={url} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-ink underline">
                Ouvrir en plein écran
              </a>
            </>
          )}
        </div>
      )}
    </>
  );
}

