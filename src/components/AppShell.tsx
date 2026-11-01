"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "./AuthProvider";
import { useRestaurant } from "./RestaurantProvider";
import { RestaurantSwitcher } from "./RestaurantSwitcher";
import { Button, Card } from "./ui";

// Sur téléphone, Fournisseurs est accessible depuis la page Factures (5 onglets max en bas).
const NAV: { href: string; label: string; icon: string; mobile?: boolean }[] = [
  { href: "/", label: "Accueil", icon: "M3 11l9-8 9 8v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z" },
  { href: "/salaries", label: "Équipe", icon: "M16 11a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0M12 7a4 4 0 1 1 0 8" },
  { href: "/fournisseurs", label: "Fournisseurs", mobile: false, icon: "M3 7h13v10H3zM16 10h4l1 3v4h-5M7 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm11 0a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
  { href: "/factures", label: "Factures", icon: "M6 2h9l5 5v15H6zM14 2v6h6M9 13h8M9 17h8" },
  { href: "/rapprochement", label: "Caisse", icon: "M3 6h18v12H3zM3 10h18M7 15h3" },
  { href: "/tva", label: "TVA", icon: "M19 5L5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm10 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" },
  { href: "/reglages", label: "Réglages", mobile: false, icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" },
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
  const { rid } = useRestaurant();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  // Une fois : les données saisies avant les deux portails sont recopiées dans Manin 19e (côté serveur).
  useEffect(() => {
    if (!user || role !== "gerant" || sessionStorage.getItem("tibs.migre")) return;
    user
      .getIdToken()
      .then((t) => fetch("/api/migrate", { method: "POST", headers: { authorization: `Bearer ${t}` } }))
      .then((r) => r.ok && sessionStorage.setItem("tibs.migre", "1"))
      .catch(() => {});
  }, [user, role]);

  if (loading || !user) {
    return <div className="flex min-h-dvh items-center justify-center text-muted">Chargement…</div>;
  }

  if (role !== "gerant") {
    return (
      <div className="flex min-h-dvh items-center justify-center p-4">
        <Card className="max-w-md space-y-3">
          <h1 className="text-lg font-semibold">Accès non autorisé</h1>
          <p className="text-sm text-muted">
            Le compte <strong>{user.email}</strong> n&apos;a pas le rôle gérant. Ajoutez un document{" "}
            <code>users/{user.uid}</code> avec <code>role: &quot;gerant&quot;</code> dans la console Firebase (voir README).
          </p>
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button variant="secondary" onClick={logout}>Se déconnecter</Button>
        </Card>
      </div>
    );
  }

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <div className="min-h-dvh bg-bg md:flex">
      {/* Barre latérale (tablette / ordinateur) */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-border bg-surface p-4 md:flex">
        <div className="mb-4 font-display text-3xl tracking-wide">Le Tib&rsquo;s<span className="ml-1 inline-block size-2 rounded-full bg-brand" aria-hidden /></div>
        <RestaurantSwitcher className="mb-6 self-start" />
        <nav className="flex flex-1 flex-col gap-1">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              className={`flex min-h-12 items-center gap-3 rounded-control px-3 text-sm font-medium ${isActive(n.href) ? "bg-bar text-white" : "text-muted hover:bg-surface-2"}`}
            >
              <Icon d={n.icon} />
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="truncate text-xs text-muted">{user.email}</div>
        <Button variant="ghost" className="mt-2 justify-start" onClick={logout}>Se déconnecter</Button>
      </aside>

      {/* En-tête (téléphone) */}
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface px-4 pt-[env(safe-area-inset-top)] md:hidden">
        <div className="py-3 font-display text-2xl tracking-wide">Le Tib&rsquo;s<span className="ml-1 inline-block size-2 rounded-full bg-brand" aria-hidden /></div>
        <div className="flex items-center gap-1">
          <RestaurantSwitcher />
          <Link href="/reglages" aria-label="Réglages" className={`flex size-11 items-center justify-center rounded-control ${isActive("/reglages") ? "bg-surface-2" : ""}`}>
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </Link>
          <Button variant="ghost" className="px-2" onClick={logout} aria-label="Se déconnecter">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden>
              <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
            </svg>
          </Button>
        </div>
      </header>

      {/* key : changer de restaurant remet chaque page à zéro (formulaires, filtres). */}
      <main key={rid} className="mx-auto w-full max-w-5xl flex-1 p-4 pb-28 md:p-8">{children}</main>

      {/* Barre de navigation du bas (téléphone) */}
      <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 bg-bar pb-[env(safe-area-inset-bottom)] md:hidden">
        {NAV.filter((n) => n.mobile !== false).map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`relative flex min-h-16 flex-col items-center justify-center gap-0.5 text-caption font-medium ${isActive(n.href) || (n.href === "/factures" && isActive("/fournisseurs")) ? "text-white before:absolute before:inset-x-4 before:top-0 before:h-[3px] before:rounded-b before:bg-brand" : "text-white/60"}`}
          >
            <Icon d={n.icon} />
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
