"use client";

import { sendPasswordResetEmail, signInWithEmailAndPassword } from "firebase/auth";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Button, ErrorBox, Field, Input } from "@/components/ui";
import { auth } from "@/lib/firebase";

export default function LoginPage() {
  const { user, loading, error: authError } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user) router.replace("/");
  }, [loading, user, router]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth(), email.trim(), password);
    } catch {
      setError("E-mail ou mot de passe incorrect.");
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    if (!email) return setError("Saisissez d'abord votre e-mail.");
    try {
      await sendPasswordResetEmail(auth(), email.trim());
      setInfo("Si ce compte existe, un e-mail de réinitialisation a été envoyé.");
    } catch {
      setError("Envoi impossible pour le moment.");
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bar p-4">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-[20px] bg-surface p-6">
        <div>
          <div className="font-display text-4xl tracking-wide">TIBS<span className="text-brand">.</span></div>
          <p className="text-sm text-muted">Espace de gestion</p>
        </div>
        <Field label="E-mail">
          <Input type="email" autoComplete="email" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Mot de passe">
          <Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <ErrorBox message={error || authError} />
        {info && <p className="text-sm text-success">{info}</p>}
        <Button type="submit" className="w-full" disabled={busy}>{busy ? "Connexion…" : "Se connecter"}</Button>
        <button type="button" onClick={onReset} className="min-h-11 w-full text-sm text-muted underline">
          Mot de passe oublié
        </button>
      </form>
    </div>
  );
}
