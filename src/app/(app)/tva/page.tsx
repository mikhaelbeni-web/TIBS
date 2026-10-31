"use client";

import { doc, getDoc, setDoc } from "firebase/firestore";
import { useEffect, useMemo, useState } from "react";
import { Button, Card, ErrorBox, Field, Input, PageHeader, Select } from "@/components/ui";
import { db } from "@/lib/firebase";
import { formatEuros } from "@/lib/money";
import type { AppSettings, CashEntry, Invoice } from "@/lib/types";
import { echeanceDuMois, prochaineEcheanceTva, tvaReport } from "@/lib/tva";
import { useCollection } from "@/lib/useCollection";

type Periode = "mois" | "trimestre" | "libre";
const fr = (iso: string) => iso.split("-").reverse().join("/");
const lastDay = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};
const num = (c: number) => (c / 100).toFixed(2).replace(".", ",");

const today = () => new Date().toISOString().slice(0, 10);
/** Mois de la prochaine échéance (envoi le 10 du mois suivant). */
const previousMonth = () => prochaineEcheanceTva(today()).mois;

export default function TvaPage() {
  const cash = useCollection<CashEntry>("cashEntries", "date");
  const invoices = useCollection<Invoice>("invoices", "dateFacture");
  const [periode, setPeriode] = useState<Periode>("mois");
  const [mois, setMois] = useState(previousMonth());
  const [libreFrom, setLibreFrom] = useState(`${previousMonth()}-01`);
  const [libreTo, setLibreTo] = useState(lastDay(previousMonth()));
  const [settings, setSettings] = useState<AppSettings>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getDoc(doc(db(), "settings", "app"))
      .then((s) => s.exists() && setSettings(s.data() as AppSettings))
      .catch((e) => setError(e.message));
  }, []);

  const { from, to } = useMemo(() => {
    if (periode === "libre") return { from: libreFrom, to: libreTo };
    if (periode === "trimestre") {
      const [y, m] = mois.split("-").map(Number);
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      const start = `${y}-${String(q).padStart(2, "0")}`;
      const end = `${y}-${String(q + 2).padStart(2, "0")}`;
      return { from: `${start}-01`, to: lastDay(end) };
    }
    return { from: `${mois}-01`, to: lastDay(mois) };
  }, [periode, mois, libreFrom, libreTo]);

  const r = useMemo(() => tvaReport(cash.items, invoices.items, from, to), [cash.items, invoices.items, from, to]);
  const label = `du ${fr(from)} au ${fr(to)}`;
  const echeance = prochaineEcheanceTva(today());
  const envoiMois = periode === "mois" ? settings.tvaEnvois?.[mois] : undefined;

  async function marquerEnvoye() {
    const tvaEnvois = { ...(settings.tvaEnvois ?? {}), [mois]: today() };
    try {
      await setDoc(doc(db(), "settings", "app"), { tvaEnvois }, { merge: true });
      setSettings({ ...settings, tvaEnvois });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function exportCsv() {
    const lines = [
      `Rapport TVA Le Tib's ${label}`,
      "",
      "TVA COLLECTÉE (ventes);Taux;TTC;HT;TVA",
      ...r.collectee.map((l) => `Ventes;${l.label};${num(l.ttc)};${num(l.ht)};${num(l.tva)}`),
      `Total collectée;;;;${num(r.totalCollectee)}`,
      "",
      `TVA DÉDUCTIBLE (factures fournisseurs);${r.nbFactures} facture(s);;HT ${num(r.facturesHT)};${num(r.deductible)}`,
      "",
      `${r.net >= 0 ? "TVA NETTE À PAYER" : "CRÉDIT DE TVA"};;;;${num(Math.abs(r.net))}`,
      "",
      "DÉTAIL DES VENTES;Date;TTC 5,5;TTC 10;TTC 20;CB;Espèces;Tickets resto;Autres",
      ...cash.items
        .filter((d) => d.date >= from && d.date <= to)
        .map((d) => `;${fr(d.date)};${num(d.ttc55 ?? 0)};${num(d.ttc10 ?? 0)};${num(d.ttc20 ?? 0)};${num(d.cb)};${num(d.especes)};${num(d.ticketsResto)};${num(d.autres)}`),
      "",
      "DÉTAIL DES FACTURES;Date;Fournisseur;N°;HT;TVA;TTC",
      ...invoices.items
        .filter((i) => i.dateFacture >= from && i.dateFacture <= to)
        .map((i) => `;${fr(i.dateFacture)};${i.supplierNom};${i.numero};${num(i.montantHT)};${num(i.montantTVA)};${num(i.montantTTC)}`),
    ];
    const blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `tva-${from}-${to}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function mailto() {
    const body = [
      `Bonjour${settings.comptableNom ? " " + settings.comptableNom : ""},`,
      "",
      `Voici les éléments de TVA du restaurant Le Tib's ${label} :`,
      ...r.collectee.filter((l) => l.ttc).map((l) => `- Ventes à ${l.label} : ${formatEuros(l.ttc)} TTC, TVA ${formatEuros(l.tva)}`),
      `- TVA collectée : ${formatEuros(r.totalCollectee)}`,
      `- TVA déductible (${r.nbFactures} factures fournisseurs) : ${formatEuros(r.deductible)}`,
      `- ${r.net >= 0 ? "TVA nette à payer" : "Crédit de TVA"} : ${formatEuros(Math.abs(r.net))}`,
      "",
      "Le détail est dans le fichier CSV joint.",
      "",
      "Cordialement",
    ].join("\n");
    const subject = `TVA Le Tib's ${label}`;
    window.location.href = `mailto:${settings.comptableEmail ?? ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function saveSettings() {
    try {
      await setDoc(doc(db(), "settings", "app"), settings, { merge: true });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <PageHeader
        title="TVA"
        action={
          <>
            <Button variant="secondary" onClick={exportCsv}>Exporter CSV</Button>
            <Button onClick={mailto}>Envoyer au comptable</Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 items-end gap-3 sm:max-w-xl">
        <Field label="Période">
          <Select value={periode} onChange={(e) => setPeriode(e.target.value as Periode)}>
            <option value="mois">Mois</option>
            <option value="trimestre">Trimestre</option>
            <option value="libre">Dates libres</option>
          </Select>
        </Field>
        {periode === "libre" ? (
          <>
            <Field label="Du"><Input type="date" value={libreFrom} onChange={(e) => setLibreFrom(e.target.value)} /></Field>
            <Field label="Au"><Input type="date" value={libreTo} onChange={(e) => setLibreTo(e.target.value)} /></Field>
          </>
        ) : (
          <Field label={periode === "mois" ? "Mois" : "Un mois du trimestre"}>
            <Input type="month" value={mois} onChange={(e) => setMois(e.target.value || previousMonth())} />
          </Field>
        )}
      </div>
      <p className="mb-4 text-sm text-muted">Période {label}</p>

      {periode === "mois" && (
        <Card className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {envoiMois ? (
            <p className="text-sm text-success">TVA de ce mois envoyée au comptable le {fr(envoiMois)}.</p>
          ) : (
            <p className={`text-sm ${mois === echeance.mois && echeance.joursRestants <= 3 ? "font-medium text-danger" : "text-ink"}`}>
              À envoyer au comptable avant le {fr(echeanceDuMois(mois))}
              {mois === echeance.mois && ` (J-${echeance.joursRestants})`}.
            </p>
          )}
          {!envoiMois && <Button variant="secondary" onClick={marquerEnvoye}>Marquer comme envoyée</Button>}
        </Card>
      )}

      <ErrorBox message={cash.error || invoices.error || error} />

      {r.nonVentile.jours.length > 0 && (
        <p className="mb-4 rounded-control bg-warning-soft p-3 text-sm text-warning">
          {r.nonVentile.jours.length} journée(s) de caisse ({formatEuros(r.nonVentile.montant)}) n&apos;ont pas de ventilation par taux et ne
          sont pas comptées dans la TVA collectée : {r.nonVentile.jours.map(fr).join(", ")}. Complétez-les dans Caisse.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <div className="mb-2 font-medium">TVA collectée sur les ventes</div>
          <ul className="divide-y divide-border text-sm">
            {r.collectee.map((l) => (
              <li key={l.label} className="flex justify-between gap-2 py-2">
                <span>{l.label} · {formatEuros(l.ttc)} TTC</span>
                <span className="tabular-nums font-medium">{formatEuros(l.tva)}</span>
              </li>
            ))}
            <li className="flex justify-between gap-2 py-2 font-semibold">
              <span>Total</span><span className="tabular-nums">{formatEuros(r.totalCollectee)}</span>
            </li>
          </ul>
        </Card>
        <Card>
          <div className="mb-2 font-medium">TVA déductible sur les factures</div>
          <div className="text-sm text-muted">{r.nbFactures} facture(s), {formatEuros(r.facturesHT)} HT</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">{formatEuros(r.deductible)}</div>
          <p className="mt-2 text-xs text-muted">
            Selon la date de facture. Pour les prestations de services, la TVA est déductible au paiement : votre comptable ajustera si besoin.
          </p>
        </Card>
        <Card className="lg:col-span-2">
          <div className="text-sm text-muted">{r.net >= 0 ? "TVA nette à payer" : "Crédit de TVA"}</div>
          <div className={`font-display text-kpi tabular-nums ${r.net >= 0 ? "" : "text-success"}`}>{formatEuros(Math.abs(r.net))}</div>
        </Card>
      </div>

      <Card className="mt-6 space-y-3">
        <div className="font-medium">Comptable</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nom"><Input value={settings.comptableNom ?? ""} onChange={(e) => setSettings({ ...settings, comptableNom: e.target.value })} /></Field>
          <Field label="E-mail">
            <Input type="email" inputMode="email" value={settings.comptableEmail ?? ""} onChange={(e) => setSettings({ ...settings, comptableEmail: e.target.value })} />
          </Field>
        </div>
        <Button variant="secondary" onClick={saveSettings}>{saved ? "Enregistré ✓" : "Enregistrer"}</Button>
        <p className="text-xs text-muted">« Envoyer au comptable » ouvre votre messagerie avec le récapitulatif ; joignez-y le CSV exporté.</p>
      </Card>
    </div>
  );
}
