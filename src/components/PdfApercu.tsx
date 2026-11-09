"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { ErrorBox } from "@/components/ui";

const MAX_PAGES = 20;
const ZOOMS = [1, 1.5, 2, 3];
// Au-delà, Safari iPhone refuse de dessiner le canvas (limite ~16 millions de pixels).
const MAX_PIXELS = 12_000_000;

/**
 * PDF joint à un mail, récupéré à la demande depuis Gmail (rien n'est stocké).
 * requete : « i=<id À vérifier> », « c=releve&i=<id relevé> » ou « f=<id facture> ».
 */
export function usePdf(requete: string) {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [data, setData] = useState<ArrayBuffer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const charger = useCallback(async () => {
    if (!user) return;
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
      setData(await res.arrayBuffer());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [rid, user, requete]);

  return { data, busy, error, charger };
}

/** Enregistre le PDF sur l'appareil (dossier Téléchargements, ou « Fichiers » sur iPhone). */
export function telecharger(data: ArrayBuffer, fichier: string) {
  const url = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fichier.toLowerCase().endsWith(".pdf") ? fichier : `${fichier}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export const nomFichier = (...parts: (string | undefined)[]) =>
  parts
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w.\- ]+/g, "_")
    .trim()
    .slice(0, 100) || "facture";

/** Bouton « Voir … » qui déplie l'aperçu sous la ligne (pages « À vérifier » et relevés fournisseurs). */
export function PdfApercu({ requete, nom }: { requete: string; nom: string }) {
  const pdf = usePdf(requete);
  const [open, setOpen] = useState(false);

  function voir() {
    if (open) return setOpen(false);
    setOpen(true);
    if (!pdf.data && !pdf.busy) void pdf.charger();
  }

  return (
    <>
      <button type="button" onClick={voir} className="font-medium text-ink underline">
        {open ? `Masquer ${nom}` : `Voir ${nom}`}
      </button>
      {open && (
        <div className="order-last mt-2 basis-full space-y-2">
          {pdf.busy && <p className="text-sm text-muted">Chargement du PDF…</p>}
          <ErrorBox message={pdf.error} />
          {pdf.data && <PdfPages data={pdf.data} fichier={nomFichier(nom.replace(/^(la|le) /, ""))} />}
        </div>
      )}
    </>
  );
}

/**
 * Pages du PDF dessinées par l'app (pdf.js, en images) : l'affichage est le même sur Chrome, Firefox, Safari
 * et téléphone, sans passer par le lecteur PDF du navigateur. Boutons zoom et « Télécharger ».
 */
export function PdfPages({ data, fichier, hauteur = "max-h-[70dvh]" }: { data: ArrayBuffer; fichier: string; hauteur?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0);
  const [etat, setEtat] = useState<{ erreur?: string; reste?: number; pages?: number }>({});

  useEffect(() => {
    let annule = false;
    const conteneur = ref.current;
    if (!conteneur) return;
    const facteur = ZOOMS[zoom];
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        // Copie : pdf.js transfère le tampon au worker, l'original reste utilisable (zoom, téléchargement).
        const tache = pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) });
        const doc = await tache.promise;
        const largeur = Math.max((conteneur.clientWidth || 600) - 16, 200) * facteur; // 16 : marge intérieure p-2
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const n = Math.min(doc.numPages, MAX_PAGES);
        for (let i = 1; i <= n && !annule; i++) {
          const page = await doc.getPage(i);
          const base = page.getViewport({ scale: 1 });
          let scale = (largeur / base.width) * dpr;
          const pixels = base.width * base.height * scale * scale;
          if (pixels > MAX_PIXELS) scale *= Math.sqrt(MAX_PIXELS / pixels);
          const viewport = page.getViewport({ scale });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.round(largeur)}px`;
          canvas.style.maxWidth = "none";
          canvas.className = "block rounded-control border border-border bg-white";
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `Page ${i} sur ${doc.numPages}`);
          await page.render({ canvas, viewport }).promise;
          // Première page affichée tout de suite, les suivantes au fur et à mesure.
          if (annule) break;
          if (i === 1) conteneur.replaceChildren(canvas);
          else conteneur.appendChild(canvas);
        }
        if (!annule) setEtat({ reste: doc.numPages - n, pages: doc.numPages });
        void tache.destroy();
      } catch (e) {
        if (!annule) setEtat({ erreur: `Aperçu impossible (${(e as Error).message}) : télécharge le PDF pour l'ouvrir.` });
      }
    })();
    return () => {
      annule = true;
    };
  }, [data, zoom]);

  const bouton = "flex size-11 items-center justify-center rounded-control border border-border bg-surface text-lg font-semibold disabled:opacity-40";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button type="button" className={bouton} aria-label="Dézoomer" disabled={zoom === 0} onClick={() => setZoom(zoom - 1)}>
            −
          </button>
          <span className="w-12 text-center text-sm tabular-nums text-muted">{ZOOMS[zoom] * 100} %</span>
          <button type="button" className={bouton} aria-label="Zoomer" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom(zoom + 1)}>
            +
          </button>
        </div>
        <button
          type="button"
          onClick={() => telecharger(data, fichier)}
          className="inline-flex min-h-11 items-center gap-2 rounded-control bg-bar px-4 text-sm font-medium text-white"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16" />
          </svg>
          Télécharger
        </button>
      </div>
      <div ref={ref} className={`${hauteur} space-y-2 overflow-auto overscroll-contain rounded-control bg-surface-2 p-2`}>
        <p className="p-4 text-center text-sm text-muted">Affichage de la facture…</p>
      </div>
      {etat.reste ? <p className="text-xs text-muted">{etat.reste} page(s) de plus : télécharge le PDF pour tout voir.</p> : null}
      <ErrorBox message={etat.erreur ?? null} />
    </div>
  );
}
