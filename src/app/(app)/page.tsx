"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Card, PageHeader } from "@/components/ui";
import { checkDpae } from "@/lib/dpae";
import { formatEuros } from "@/lib/money";
import type { CashEntry, Employee, Invoice } from "@/lib/types";
import { useCollection } from "@/lib/useCollection";

export default function Dashboard() {
  const employees = useCollection<Employee>("employees", "dateEmbauche", true);
  const invoices = useCollection<Invoice>("invoices", "dateFacture", true);
  const cash = useCollection<CashEntry>("cashEntries", "date", true);
  const mois = new Date().toISOString().slice(0, 7);

  const dpae = useMemo(() => {
    const todo = employees.items.filter((e) => e.dpaeStatut !== "declaree");
    return { todo: todo.length, late: todo.filter((e) => checkDpae(e).errors.some((m) => m.includes("retard"))).length };
  }, [employees.items]);
  const due = useMemo(() => {
    const open = invoices.items.filter((i) => i.statut === "a_payer");
    return { count: open.length, total: open.reduce((s, i) => s + i.montantTTC, 0) };
  }, [invoices.items]);
  const monthCash = cash.items.filter((c) => c.date.startsWith(mois));

  const tiles = [
    {
      href: "/salaries",
      title: "DPAE à faire",
      value: String(dpae.todo),
      sub: dpae.late ? `${dpae.late} en retard` : "Aucune en retard",
      alert: dpae.late > 0,
    },
    { href: "/factures", title: "Factures à payer", value: formatEuros(due.total), sub: `${due.count} facture(s)`, alert: false },
    {
      href: "/rapprochement",
      title: "Caisse du mois",
      value: formatEuros(monthCash.reduce((s, c) => s + c.cb + c.especes + c.ticketsResto + c.autres, 0)),
      sub: `${monthCash.length} journée(s) saisie(s)`,
      alert: false,
    },
  ];

  return (
    <div>
      <PageHeader title="Tableau de bord" />
      <div className="grid gap-3 sm:grid-cols-3">
        {tiles.map((t) => (
          <Link key={t.href} href={t.href}>
            <Card className="h-full hover:border-ink">
              <div className="text-sm text-muted">{t.title}</div>
              <div className="mt-1 font-display text-kpi">{t.value}</div>
              <div className={`text-sm ${t.alert ? "font-medium text-danger" : "text-muted"}`}>{t.sub}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
