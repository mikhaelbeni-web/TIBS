"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { DEFAULT_RESTAURANT, isRestaurantId, restaurant, type Restaurant, type RestaurantId } from "@/lib/restaurants";

const KEY = "tibs.restaurant";

interface RestaurantState {
  rid: RestaurantId;
  current: Restaurant;
  setRid: (id: RestaurantId) => void;
}

const Ctx = createContext<RestaurantState | null>(null);

/** Restaurant actif (portail), mémorisé sur l'appareil. */
export function RestaurantProvider({ children }: { children: ReactNode }) {
  const [rid, setState] = useState<RestaurantId>(() => {
    if (typeof window === "undefined") return DEFAULT_RESTAURANT;
    const saved = window.localStorage.getItem(KEY);
    return isRestaurantId(saved) ? saved : DEFAULT_RESTAURANT;
  });
  const setRid = useCallback((id: RestaurantId) => {
    window.localStorage.setItem(KEY, id);
    setState(id);
  }, []);
  return <Ctx.Provider value={{ rid, current: restaurant(rid), setRid }}>{children}</Ctx.Provider>;
}

export function useRestaurant(): RestaurantState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useRestaurant doit être utilisé dans RestaurantProvider");
  return v;
}
