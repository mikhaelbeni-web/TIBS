"use client";

import { doc, getDoc } from "firebase/firestore";
import { useEffect, useState } from "react";
import { db } from "@/lib/firebase";
import { formatEuros } from "@/lib/money";
import { RESTAURANTS, type RestaurantId } from "@/lib/restaurants";
import type { CashEntry } from "@/lib/types";
import { useRestaurant } from "./RestaurantProvider";
import { Sheet } from "./ui";

const today = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const total = (c: CashEntry) => c.cb + c.especes + c.ticketsResto + c.autres;

/** Pastille « Manin 19e ⌄ » dans l'en-tête, qui ouvre le choix du restaurant. */
export function RestaurantSwitcher({ className = "" }: { className?: string }) {
  const { rid, current, setRid } = useRestaurant();
  const [open, setOpen] = useState(false);
  const [ca, setCa] = useState<Partial<Record<RestaurantId, number | null>>>({});

  useEffect(() => {
    if (!open) return;
    const d = today();
    let alive = true;
    Promise.all(
      RESTAURANTS.map((r) =>
        getDoc(doc(db(), "restaurants", r.id, "cashEntries", d))
          .then((s) => [r.id, s.exists() ? total(s.data() as CashEntry) : null] as const)
          .catch(() => [r.id, null] as const),
      ),
    ).then((rows) => alive && setCa(Object.fromEntries(rows)));
    return () => {
      alive = false;
    };
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`inline-flex min-h-11 items-center gap-2 rounded-full border border-border bg-surface px-3 text-sm font-semibold ${className}`}
        aria-label={`Restaurant : ${current.court}. Changer de restaurant`}
      >
        <span className={`size-2.5 rounded-full ${current.couleur}`} aria-hidden />
        {current.court}
        <svg viewBox="0 0 24 24" className="size-4 text-muted" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Choisir le restaurant">
        <ul className="space-y-2">
          {RESTAURANTS.map((r) => {
            const active = r.id === rid;
            const jour = ca[r.id];
            return (
              <li key={r.id}>
                <button
                  onClick={() => {
                    setRid(r.id);
                    setOpen(false);
                  }}
                  aria-current={active}
                  className={`flex w-full items-center gap-3 rounded-card bg-surface p-3 text-left ${active ? "border-2 border-ink" : "border border-border"}`}
                >
                  <span className={`flex size-11 shrink-0 items-center justify-center rounded-control font-display text-xl ${r.couleur} ${r.surCouleur}`}>
                    {r.id.slice(0, 2)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">{r.nom}</span>
                    <span className="block truncate text-sm text-muted">{r.adresse}</span>
                  </span>
                  <span className="shrink-0 text-right text-sm">
                    <span className="block text-caption text-muted">CA du jour</span>
                    <span className="font-semibold tabular-nums">{jour === undefined ? "…" : jour === null ? "–" : formatEuros(jour)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </>
  );
}
