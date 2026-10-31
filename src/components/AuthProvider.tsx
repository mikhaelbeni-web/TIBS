"use client";

import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { auth, db, firebaseApp, initAnalytics } from "@/lib/firebase";
import type { Role } from "@/lib/types";

interface AuthState {
  loading: boolean;
  user: User | null;
  role: Role | null;
  error: string | null;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Erreur de configuration détectée une seule fois (variables d'environnement absentes).
  const [configError] = useState<string | null>(() => {
    try {
      firebaseApp();
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  });
  const [state, setState] = useState<Omit<AuthState, "logout">>({
    loading: configError === null,
    user: null,
    role: null,
    error: configError,
  });

  useEffect(() => {
    if (configError) return;
    void initAnalytics();
    return onAuthStateChanged(auth(), async (user) => {
      if (!user) return setState({ loading: false, user: null, role: null, error: null });
      try {
        const snap = await getDoc(doc(db(), "users", user.uid));
        const role = (snap.exists() ? snap.data().role : null) as Role | null;
        setState({ loading: false, user, role, error: null });
      } catch (e) {
        setState({ loading: false, user, role: null, error: (e as Error).message });
      }
    });
  }, [configError]);

  return (
    <AuthContext.Provider value={{ ...state, logout: () => signOut(auth()) }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit être utilisé dans <AuthProvider>");
  return ctx;
}
