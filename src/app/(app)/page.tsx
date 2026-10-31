"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, PageHeader } from "@/components/ui";
import { checkDpae } from "@/lib/dpae";
import { formatEuros } from "@/lib/money";
import { prochaineEcheanceTva } from "@/lib/tva";
import { doc, onSnapshot } from "firebase/firestore";
import { useRestaurant } from "@/components/RestaurantProvider";
import { db } from "@/lib/firebase";
import type { AppSettings } from "@/lib/types";
import type { InboxDoc } from "@/lib/ingest";
import type { CashEntry, Employee, Invoice } from "@/lib/types";
import { useCollection } from "@/lib/useCollection";

export default function Dashboard() {
  const { rid } = useRestaurant();
  const employees = useCollection<Employee>("employees", "dateEmbauche", true);
  const invoices = useCollection<Invoice>("invoices", "dateFacture", true);
  const cash = useCollection<CashEntry>("cashEntries", "date", true);
  const inbox = useCollection<InboxDoc>("inbox", "receivedAt", true);
  const aVerifier = inbox.items.filter((i) => i.statut === "a_verifier").length;
  const today = new Date().toISOString().slice(0, 10);
  const mois = today.slice(0, 7);
  const [settings, setSettings] = useState<AppSettings>({});
  useEffect(() => onSnapshot(doc(db(), "restaurants", rid, "settings", "app"), (s) => setSettings((s.data() as AppSettings) ?? {}), () => {}), [rid]);
  const tva = prochaineEcheanceTva(today);
  const tvaEnvoyee = settings.tvaEnvois?.[tva.mois];
  const nomMois = new Date(`${tva.mois}-01T00:00:00Z`).toLocaleDateString("fr-FR", { month: "long", timeZone: "UTC" });

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
      href: "/a-verifier",
      title: "Reçu par mail",
      value: String(aVerifier),
      sub: aVerifier ? "à vérifier" : "Rien en attente",
      alert: aVerifier > 0,
    },
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
    {
      href: "/tva",
      title: `TVA de ${nomMois}`,
      value: tvaEnvoyee ? "Envoyée" : `J-${tva.joursRestants}`,
      sub: tvaEnvoyee ? `le ${tvaEnvoyee.split("-").reverse().join("/")}` : `à envoyer avant le ${tva.date.split("-").reverse().join("/")}`,
      alert: !tvaEnvoyee && tva.joursRestants <= 3,
    },
  ];

  return (
    <div>
      <PageHeader title="Tableau de bord" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
