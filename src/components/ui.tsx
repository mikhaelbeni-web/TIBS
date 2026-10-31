"use client";

import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

// Primitives mobile d'abord : cibles tactiles >= 44 px, police 16 px dans les champs (pas de zoom iOS).

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost" }) {
  const styles = {
    primary: "bg-primary text-primary-fg font-semibold hover:brightness-95 disabled:opacity-50",
    secondary: "bg-surface text-ink border border-border hover:bg-surface-2",
    danger: "bg-surface text-danger border border-danger/40 hover:bg-danger-soft",
    ghost: "text-muted hover:bg-surface-2",
  }[variant];
  return (
    <button
      className={`inline-flex min-h-12 items-center justify-center gap-2 rounded-control px-4 text-sm font-medium transition disabled:cursor-not-allowed ${styles} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}

const inputCls =
  "min-h-12 w-full rounded-control border border-border bg-surface px-3 text-base outline-none focus:border-ink focus:ring-2 focus:ring-primary/60";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${inputCls} ${props.className ?? ""}`} />;
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-card border border-border bg-surface p-4 ${className}`}>{children}</div>;
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="font-display text-title uppercase tracking-wide">{title}</h1>
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "green" | "orange" | "red" | "info" }) {
  const t = {
    neutral: "bg-surface-2 text-ink",
    green: "bg-success-soft text-success",
    orange: "bg-warning-soft text-warning",
    red: "bg-danger-soft text-danger",
    info: "bg-info-soft text-info",
  }[tone];
  return <span className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-caption font-semibold ${t}`}>{children}</span>;
}

export function ErrorBox({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="rounded-control bg-danger-soft p-3 text-sm text-danger">{message}</p>;
}

/** Feuille qui monte du bas sur téléphone, fenêtre centrée sur grand écran. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[92dvh] w-full flex-col rounded-t-[20px] bg-surface shadow-sheet sm:max-w-lg sm:rounded-[20px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} aria-label="Fermer" className="flex size-12 items-center justify-center rounded-control text-2xl hover:bg-surface-2">
            ×
          </button>
        </div>
        <div className="overflow-y-auto p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted">{children}</p>;
}
