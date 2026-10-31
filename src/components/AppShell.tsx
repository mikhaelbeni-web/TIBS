"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { Button, Card } from "./ui";

// Sur téléphone, Fournisseurs est accessible depuis la page Factures (5 onglets max en bas).
const NAV: { href: string; label: string; icon: string; mobile?: boolean }[] = [
  { href: "/", label: "Accueil", icon: "M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" },
  { href: "/salaries", label: "Salariés", icon: "M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0M12 7a4 4 0 1 1 0 8" },
  { href: "/fournisseurs", label: "Fournisseurs", mobile: false, icon: "M3 7h13v10H3zM16 10h4l1 3v4h-5M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
  { href: "/factures", label: "Factures", icon: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8" },
  { href: "/rapprochement", label: "Caisse", icon: "M3 6h18v12H3zM3 10h18M7 15h3" },
  { href: "/tva", label: "TVA", icon: "M19 5L5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm10 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
];

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { loading, user, role, error, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading || !user) {
    return <div className="flex min-h-dvh items-center justify-center text-neutral-500">Chargement…</div>;
  }

  if (role !== "gerant") {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="max-w-md space-y-3">
          <h1 className="text-lg font-semibold">Accès non autorisé</h1>
          <p className="text-sm text-neutral-600">
            Le compte <strong>{user.email}</strong> n&apos;a pas le rôle gérant. Ajoutez un document{" "}
            <code>users/{user.uid}</code> avec <code>role: &quot;gerant&quot;</code> dans la console Firebase (voir README).
          </p>
          {error && <p className="text-sm text-red-700">{error}</p>}
          <Button variant="secondary" onClick={logout}>Se déconnecter</Button>
        </Card>
      </div>
    );
  }

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href) || (href === "/factures" && pathname.startsWith("/fournisseurs"));

  return (
    <div className="min-h-dvh bg-neutral-50 md:flex">
      {/* Barre latérale (tablette / ordinateur) */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-neutral-200 bg-white p-4 md:flex">
        <div className="mb-6 text-2xl font-black tracking-tight">TIBS</div>
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium ${isActive(n.href) ? "bg-black text-white" : "text-neutral-700 hover:bg-neutral-100"}`}
            >
              <Icon d={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="truncate text-xs text-neutral-500">{user.email}</div>
        <Button variant="ghost" className="mt-2 justify-start" onClick={logout}>Se déconnecter</Button>
      </aside>

      {/* En-tête (téléphone) */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-neutral-200 bg-white/95 px-4 pt-[env(safe-area-inset-top)] backdrop-blur md:hidden">
        <div className="py-3 text-xl font-black tracking-tight">TIBS</div>
        <Button variant="ghost" onClick={logout}>Déconnexion</Button>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 p-4 pb-28 md:p-8">{children}</main>

      {/* Barre de navigation du bas (téléphone) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-neutral-200 bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.filter((n) => n.mobile !== false).map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`flex min-h-16 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${isActive(n.href) ? "text-black" : "text-neutral-400"}`}
          >
            <Icon d={n.icon} />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
