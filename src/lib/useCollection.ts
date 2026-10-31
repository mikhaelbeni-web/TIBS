"use client";

import { collection, onSnapshot, orderBy, query, type DocumentData } from "firebase/firestore";
import { useEffect, useState } from "react";
import { db } from "./firebase";
import type { WithId } from "./types";

/** Abonnement temps réel à une collection, triée par un champ. */
export function useCollection<T extends DocumentData>(name: string, orderField: string, desc = false) {
  const [items, setItems] = useState<WithId<T>[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const q = query(collection(db(), name), orderBy(orderField, desc ? "desc" : "asc"));
    return onSnapshot(
      q,
      (snap) => {
        setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as T) })));
        setLoading(false);
      },
      (e) => {
        setError(e.message);
        setLoading(false);
      },
    );
  }, [name, orderField, desc]);

  return { items, loading, error };
}
