"use client";

import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { ErrorBox } from "@/components/ui";

const MAX_PAGES = 10;

/**
 * Aperçu du PDF joint, récupéré à la demande depuis Gmail (rien n'est stocké).
 * Les pages sont dessinées par l'app (pdf.js) : l'affichage ne dépend pas du lecteur PDF du navigateur
 * (Chrome réglé sur « télécharger les PDF » n'affichait qu'un bouton « Ouvrir », Safari iPhone que la 1re page).
 */
export function PdfApercu({ requete, nom }: { requete: string; nom: string }) {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [data, setData] = useState<ArrayBuffer | null>(null);
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
    if (data || !user) return;
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
      const buf = await res.arrayBuffer();
      setUrl(URL.createObjectURL(new Blob([buf], { type: "application/pdf" })));
      setData(buf);
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
          {data && <Pages data={data} />}
          {url && (
            <a href={url} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-ink underline">
              Ouvrir en plein écran
            </a>
          )}
        </div>
      )}
    </>
  );
}

function Pages({ data }: { data: ArrayBuffer }) {
  const ref = useRef<HTMLDivElement>(null);
  const [etat, setEtat] = useState<{ erreur?: string; reste?: number }>({});

  useEffect(() => {
    let annule = false;
    const conteneur = ref.current;
    if (!conteneur) return;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        // Copie : pdf.js transfère le tampon au worker, l'original reste utilisable pour un nouvel affichage.
        const tache = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
        const doc = await tache.promise;
        conteneur.replaceChildren();
        const largeur = conteneur.clientWidth || 600;
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const n = Math.min(doc.numPages, MAX_PAGES);
        for (let i = 1; i <= n && !annule; i++) {
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          const viewport = page.getViewport({ scale: (largeur / base.width) * dpr });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = "100%";
          canvas.className = "block rounded-control border border-border bg-white";
          canvas.setAttribute("aria-label", `Page ${i}`);
          conteneur.appendChild(canvas);
          await page.render({ canvas, viewport }).promise;
        }
        if (!annule) setEtat({ reste: doc.numPages - n });
        void tache.destroy();
      } catch (e) {
        if (!annule) setEtat({ erreur: `Aperçu impossible (${(e as Error).message}) : utilise « Ouvrir en plein écran ».` });
      }
    })();
    return () => {
      annule = true;
    };
  }, [data]);

  return (
    <>
      <div ref={ref} className="max-h-[70dvh] space-y-2 overflow-y-auto" />
      {etat.reste ? <p className="text-xs text-muted">{etat.reste} page(s) de plus : ouvre en plein écran.</p> : null}
      <ErrorBox message={etat.erreur ?? null} />
    </>
  );
}
