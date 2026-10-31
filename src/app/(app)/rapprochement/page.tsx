"use client";

import { deleteDoc, doc, setDoc, writeBatch } from "firebase/firestore";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Sheet } from "@/components/ui";
import { bankDocId, isCashDeposit, isUber, rowToUber, rowsToCash } from "@/lib/cashImport";
import { db } from "@/lib/firebase";
import { readSpreadsheet, rowToBank } from "@/lib/importer";
import { formatEuros, toCents } from "@/lib/money";
import { reconcile, reconcileDeposits, type BankLine, type CashLine } from "@/lib/reconcile";
import type { BankTransaction, CashEntry, UberPayout, WithId } from "@/lib/types";
import { useCollection } from "@/lib/useCollection";

const fr = (iso: string) => iso.split("-").reverse().join("/");
const thisMonth = () => new Date().toISOString().slice(0, 7);

function monthBounds(mois: string, extraDays: number) {
  const [y, m] = mois.split("-").map(Number);
  const start = `${mois}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const endPlus = new Date(Date.UTC(y, m, 0) + extraDays * 86400000).toISOString().slice(0, 10);
  return { start, end, endPlus };
}

export default function RapprochementPage() {
  const cash = useCollection<CashEntry>("cashEntries", "date");
  const bank = useCollection<BankTransaction>("bankTransactions", "date");
  const uber = useCollection<UberPayout>("uberPayouts", "date");
  const [mois, setMois] = useState(thisMonth());
  const [tab, setTab] = useState<"cb" | "especes" | "uber" | "banque">("cb");
  const [maxFee, setMaxFee] = useState("3");
  const [maxDays, setMaxDays] = useState("5");
  const [adding, setAdding] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const cashFile = useRef<HTMLInputElement>(null);
  const bankFile = useRef<HTMLInputElement>(null);
  const uberFile = useRef<HTMLInputElement>(null);

  const { start, end, endPlus } = monthBounds(mois, 14);
  const days = useMemo(() => cash.items.filter((c) => c.date >= start && c.date <= end), [cash.items, start, end]);
  const credits = useMemo(
    () => bank.items.filter((b) => b.date >= start && b.date <= endPlus && b.montant > 0),
    [bank.items, start, endPlus],
  );
  const monthBank = useMemo(() => bank.items.filter((b) => b.date >= start && b.date <= end), [bank.items, start, end]);

  const cb = useMemo(() => {
    const cashLines: CashLine[] = days.map((d) => ({ id: d.id, date: d.date, amount: d.cb }));
    const bankLines: BankLine[] = credits
      .filter((b) => !isCashDeposit(b.libelle) && !isUber(b.libelle))
      .map((b) => ({ id: b.id, date: b.date, amount: b.montant, libelle: b.libelle }));
    return reconcile(cashLines, bankLines, {
      maxDays: Number(maxDays) || 5,
      maxFeeRate: (Number(maxFee.replace(",", ".")) || 0) / 100,
      tolerance: 1,
    });
  }, [days, credits, maxDays, maxFee]);

  const esp = useMemo(() => {
    const cashLines: CashLine[] = days.map((d) => ({ id: d.id, date: d.date, amount: d.especes }));
    const deposits: BankLine[] = credits
      .filter((b) => isCashDeposit(b.libelle))
      .map((b) => ({ id: b.id, date: b.date, amount: b.montant, libelle: b.libelle }));
    return reconcileDeposits(cashLines, deposits, { maxDays: 14, tolerance: 0 });
  }, [days, credits]);

  const ub = useMemo(() => {
    const payouts: CashLine[] = uber.items
      .filter((u) => u.date >= start && u.date <= end)
      .map((u) => ({ id: u.id, date: u.date, amount: u.montant }));
    const virements: BankLine[] = credits
      .filter((b) => isUber(b.libelle))
      .map((b) => ({ id: b.id, date: b.date, amount: b.montant, libelle: b.libelle }));
    // Montants nets des deux côtés : égalité au centime, virement entre J-2 et J+5.
    return reconcile(payouts, virements, { minDays: -2, maxDays: 5, maxFeeRate: 0, tolerance: 1 });
  }, [uber.items, credits, start, end]);
  const uberById = new Map(uber.items.map((u) => [u.id, u]));

  const totalCbCaisse = days.reduce((s, d) => s + d.cb, 0);
  const totalCbBanque = cb.matches.reduce((s, m) => s + m.bank.amount, 0);
  const totalEsp = days.reduce((s, d) => s + d.especes, 0);
  const totalEspDeposes = esp.matches.reduce((s, m) => s + m.deposit.amount, 0);

  async function importCash(f?: File) {
    if (!f) return;
    setOpError(null);
    try {
      const drafts = rowsToCash(await readSpreadsheet(f));
      if (!drafts.length) throw new Error("Aucune journée reconnue. Colonnes attendues : Date, CB, Espèces, Tickets resto, Autres (et TTC 5,5 / TTC 10 / TTC 20 pour la TVA).");
      const batch = writeBatch(db());
      drafts.forEach((d) => batch.set(doc(db(), "cashEntries", d.date), { ...d, createdAt: Date.now() }));
      await batch.commit();
      setInfo(`${drafts.length} journée(s) de caisse importée(s).`);
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      if (cashFile.current) cashFile.current.value = "";
    }
  }

  async function importUber(f?: File) {
    if (!f) return;
    setOpError(null);
    try {
      const rows = (await readSpreadsheet(f)).map(rowToUber).filter((r) => r !== null);
      if (!rows.length) throw new Error("Aucun versement reconnu. Colonnes attendues : Date du versement, Montant net (et si possible Ventes, Frais Uber, Référence).");
      const seen = new Map<string, number>();
      const batch = writeBatch(db());
      for (const r of rows) {
        const key = `${r.date}_${r.montant}`;
        const n = seen.get(key) ?? 0;
        seen.set(key, n + 1);
        batch.set(doc(db(), "uberPayouts", `${key}_${n}`), { ...r, createdAt: Date.now() });
      }
      await batch.commit();
      setInfo(`${rows.length} versement(s) Uber Eats importé(s).`);
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      if (uberFile.current) uberFile.current.value = "";
    }
  }

  async function importBank(f?: File) {
    if (!f) return;
    setOpError(null);
    try {
      const rows = (await readSpreadsheet(f)).map(rowToBank).filter((r) => r !== null);
      if (!rows.length) throw new Error("Aucune opération reconnue. Colonnes attendues : Date, Libellé, Montant (ou Débit / Crédit).");
      const importId = `${Date.now()}`;
      const seen = new Map<string, number>();
      // Firestore limite un lot à 500 écritures.
      for (let i = 0; i < rows.length; i += 450) {
        const batch = writeBatch(db());
        for (const r of rows.slice(i, i + 450)) {
          const key = `${r.date}|${r.montant}|${r.libelle}`;
          const n = seen.get(key) ?? 0;
          seen.set(key, n + 1);
          batch.set(doc(db(), "bankTransactions", bankDocId(r.date, r.montant, r.libelle, n)), { ...r, importId, createdAt: Date.now() });
        }
        await batch.commit();
      }
      setInfo(`${rows.length} opération(s) bancaire(s) importée(s). Les doublons d'un précédent import sont ignorés.`);
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      if (bankFile.current) bankFile.current.value = "";
    }
  }

  const cashById = new Map(days.map((d) => [d.id, d]));

  return (
    <div>
      <PageHeader
        title="Pointage caisse / banque"
        action={
          <>
            <Button variant="secondary" onClick={() => cashFile.current?.click()}>Importer caisse</Button>
            <Button variant="secondary" onClick={() => bankFile.current?.click()}>Importer relevé</Button>
            <Button variant="secondary" onClick={() => uberFile.current?.click()}>Importer Uber</Button>
            <Button onClick={() => setAdding(true)}>+ Journée</Button>
          </>
        }
      />
      <input ref={cashFile} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => importCash(e.target.files?.[0])} />
      <input ref={bankFile} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => importBank(e.target.files?.[0])} />
      <input ref={uberFile} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => importUber(e.target.files?.[0])} />

      <div className="mb-4 grid grid-cols-2 items-end gap-2 sm:max-w-xl sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <Field label="Mois"><Input type="month" value={mois} onChange={(e) => setMois(e.target.value || thisMonth())} /></Field>
        </div>
        <Field label="Commission CB max %"><Input inputMode="decimal" value={maxFee} onChange={(e) => setMaxFee(e.target.value)} /></Field>
        <Field label="Délai max (jours)"><Input inputMode="numeric" value={maxDays} onChange={(e) => setMaxDays(e.target.value)} /></Field>
      </div>

      <ErrorBox message={cash.error || bank.error || uber.error || opError} />
      {info && <p className="mb-3 rounded-control bg-success-soft p-3 text-sm text-success">{info}</p>}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><div className="text-xs text-muted">CB caisse</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totalCbCaisse)}</div></Card>
        <Card>
          <div className="text-xs text-muted">CB pointée en banque</div>
          <div className="text-lg font-semibold tabular-nums">{formatEuros(totalCbBanque)}</div>
          <div className="text-xs text-muted">{cb.unmatchedCash.length} jour(s) non pointé(s)</div>
        </Card>
        <Card><div className="text-xs text-muted">Espèces caisse</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totalEsp)}</div></Card>
        <Card>
          <div className="text-xs text-muted">Espèces déposées pointées</div>
          <div className="text-lg font-semibold tabular-nums">{formatEuros(totalEspDeposes)}</div>
          <div className={`text-xs ${totalEsp - totalEspDeposes ? "text-warning" : "text-muted"}`}>
            Non déposé : {formatEuros(totalEsp - totalEspDeposes)}
          </div>
        </Card>
      </div>

      <div className="mb-4 grid grid-cols-4 gap-2 sm:flex">
        <Button variant={tab === "cb" ? "primary" : "secondary"} onClick={() => setTab("cb")}>CB</Button>
        <Button variant={tab === "especes" ? "primary" : "secondary"} onClick={() => setTab("especes")}>Espèces</Button>
        <Button variant={tab === "uber" ? "primary" : "secondary"} onClick={() => setTab("uber")}>Uber</Button>
        <Button variant={tab === "banque" ? "primary" : "secondary"} onClick={() => setTab("banque")}>Relevé</Button>
      </div>

      {cash.loading || bank.loading || uber.loading ? (
        <p className="text-muted">Chargement…</p>
      ) : tab === "cb" ? (
        <div className="space-y-4">
          {days.length === 0 && <Empty>Aucune journée de caisse ce mois-ci. Importez votre export ou ajoutez une journée.</Empty>}
          <ul className="space-y-2">
            {cb.matches.map((m) => {
              const rate = m.cash.amount ? (-m.ecart / m.cash.amount) * 100 : 0;
              return (
                <li key={m.cash.id}>
                  <Card className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">Caisse du {fr(m.cash.date)} · {formatEuros(m.cash.amount)}</div>
                      <div className="truncate text-sm text-muted">
                        Banque le {fr(m.bank.date)} (J+{m.days}) · {formatEuros(m.bank.amount)} · {m.bank.libelle}
                      </div>
                    </div>
                    <Badge tone={m.ecart === 0 ? "green" : "neutral"}>
                      {m.ecart === 0 ? "OK" : `${formatEuros(m.ecart)} (${rate.toFixed(2)} %)`}
                    </Badge>
                  </Card>
                </li>
              );
            })}
          </ul>
          {cb.unmatchedCash.length > 0 && (
            <Card className="border-danger/30">
              <div className="mb-2 font-medium text-danger">Jours de caisse sans remise CB trouvée</div>
              <ul className="space-y-1 text-sm">
                {cb.unmatchedCash.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2"><span>{fr(c.date)}</span><span className="tabular-nums">{formatEuros(c.amount)}</span></li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Causes fréquentes : remise pas encore créditée, plusieurs jours regroupés, commission au-delà du seuil, transaction annulée en caisse.
              </p>
            </Card>
          )}
          {cb.unmatchedBank.length > 0 && (
            <Card className="border-warning/30">
              <div className="mb-2 font-medium text-warning">Crédits bancaires non rattachés</div>
              <ul className="space-y-1 text-sm">
                {cb.unmatchedBank.map((b) => (
                  <li key={b.id} className="flex justify-between gap-2">
                    <span className="truncate">{fr(b.date)} · {b.libelle}</span>
                    <span className="shrink-0 tabular-nums">{formatEuros(b.amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : tab === "uber" ? (
        <div className="space-y-4">
          {ub.matches.length === 0 && ub.unmatchedCash.length === 0 && ub.unmatchedBank.length === 0 && (
            <Empty>Aucun versement Uber Eats ce mois-ci. Importe le relevé de paiements depuis le Manager Uber Eats.</Empty>
          )}
          <ul className="space-y-2">
            {ub.matches.map((m) => {
              const p = uberById.get(m.cash.id);
              return (
                <li key={m.cash.id}>
                  <Card className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">Versement du {fr(m.cash.date)} · {formatEuros(m.cash.amount)}</div>
                      <div className="truncate text-sm text-muted">
                        Banque le {fr(m.bank.date)} · {m.bank.libelle}
                        {p?.brut ? ` · ventes ${formatEuros(p.brut)}` : ""}
                        {p?.frais ? ` · frais ${formatEuros(p.frais)}` : ""}
                      </div>
                    </div>
                    <Badge tone="green">Rapproché</Badge>
                  </Card>
                </li>
              );
            })}
          </ul>
          {ub.unmatchedCash.length > 0 && (
            <Card className="border-danger/30">
              <div className="mb-2 font-medium text-danger">Versements Uber sans virement trouvé en banque</div>
              <ul className="space-y-1 text-sm">
                {ub.unmatchedCash.map((c) => (
                  <li key={c.id} className="flex justify-between gap-2">
                    <span>{fr(c.date)}{uberById.get(c.id)?.reference ? ` · ${uberById.get(c.id)?.reference}` : ""}</span>
                    <span className="tabular-nums">{formatEuros(c.amount)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Virement pas encore arrivé, montant différent (ajustement, remboursement client) ou relevé bancaire pas encore importé.</p>
            </Card>
          )}
          {ub.unmatchedBank.length > 0 && (
            <Card className="border-warning/30">
              <div className="mb-2 font-medium text-warning">Virements UBER en banque sans versement correspondant</div>
              <ul className="space-y-1 text-sm">
                {ub.unmatchedBank.map((b) => (
                  <li key={b.id} className="flex justify-between gap-2">
                    <span className="truncate">{fr(b.date)} · {b.libelle}</span>
                    <span className="shrink-0 tabular-nums">{formatEuros(b.amount)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : tab === "especes" ? (
        <div className="space-y-4">
          {esp.matches.length === 0 && esp.unmatchedDeposits.length === 0 && (
            <Empty>Aucun dépôt d&apos;espèces trouvé dans le relevé (libellés contenant « ESP », « VERSEMENT » ou « DÉPÔT »).</Empty>
          )}
          <ul className="space-y-2">
            {esp.matches.map((m) => (
              <li key={m.deposit.id}>
                <Card>
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium">Dépôt du {fr(m.deposit.date)} · {formatEuros(m.deposit.amount)}</div>
                    <Badge tone="green">OK</Badge>
                  </div>
                  <div className="text-sm text-muted">
                    Couvre : {m.days.map((d) => `${fr(d.date)} (${formatEuros(d.amount)})`).join(", ")}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
          {esp.unmatchedDeposits.length > 0 && (
            <Card className="border-danger/30">
              <div className="mb-2 font-medium text-danger">Dépôts qui ne correspondent à aucune suite de jours</div>
              <ul className="space-y-1 text-sm">
                {esp.unmatchedDeposits.map((d) => (
                  <li key={d.id} className="flex justify-between gap-2"><span>{fr(d.date)} · {d.libelle}</span><span className="tabular-nums">{formatEuros(d.amount)}</span></li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Écart possible : erreur de comptage, fond de caisse, sortie d&apos;espèces non saisie.</p>
            </Card>
          )}
          {esp.unmatchedDays.length > 0 && (
            <Card>
              <div className="mb-2 font-medium">Espèces encaissées pas encore déposées</div>
              <ul className="space-y-1 text-sm">
                {esp.unmatchedDays.map((d) => (
                  <li key={d.id} className="flex justify-between gap-2"><span>{fr(d.date)}</span><span className="tabular-nums">{formatEuros(d.amount)}</span></li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {monthBank.length === 0 ? (
            <Empty>Aucune opération importée pour ce mois.</Empty>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border bg-surface">
              {monthBank.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{b.libelle}</div>
                    <div className="text-xs text-muted">{fr(b.date)}</div>
                  </div>
                  <span className={`shrink-0 font-medium tabular-nums ${b.montant < 0 ? "text-danger" : "text-success"}`}>{formatEuros(b.montant)}</span>
                </li>
              ))}
            </ul>
          )}
          <h2 className="font-semibold">Journées de caisse</h2>
          <ul className="divide-y divide-border rounded-card border border-border bg-surface">
            {days.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                <div>
                  <div className="font-medium">{fr(d.date)}</div>
                  <div className="text-xs text-muted">
                    CB {formatEuros(d.cb)} · Esp. {formatEuros(d.especes)} · TR {formatEuros(d.ticketsResto)}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => confirm(`Supprimer la journée du ${fr(d.date)} ?`) && deleteDoc(doc(db(), "cashEntries", d.id))}>
                  Suppr.
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Sheet open={adding} onClose={() => setAdding(false)} title="Journée de caisse">
        {adding && <CashForm existing={cashById} onDone={() => setAdding(false)} />}
      </Sheet>
    </div>
  );
}

function CashForm({ existing, onDone }: { existing: Map<string, WithId<CashEntry>>; onDone: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [v, setV] = useState({ cb: "", especes: "", ticketsResto: "", autres: "", ttc55: "", ttc10: "", ttc20: "", note: "" });
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const data = {
      date,
      cb: toCents(v.cb) ?? 0,
      especes: toCents(v.especes) ?? 0,
      ticketsResto: toCents(v.ticketsResto) ?? 0,
      autres: toCents(v.autres) ?? 0,
      ttc55: toCents(v.ttc55) ?? 0,
      ttc10: toCents(v.ttc10) ?? 0,
      ttc20: toCents(v.ttc20) ?? 0,
      ...(v.note ? { note: v.note } : {}),
      createdAt: Date.now(),
    };
    if (existing.has(date) && !confirm("Une journée existe déjà à cette date. La remplacer ?")) return;
    try {
      await setDoc(doc(db(), "cashEntries", date), data);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Date"><Input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      <div className="grid grid-cols-2 items-end gap-3">
        <Field label="CB €"><Input inputMode="decimal" value={v.cb} onChange={(e) => setV({ ...v, cb: e.target.value })} /></Field>
        <Field label="Espèces €"><Input inputMode="decimal" value={v.especes} onChange={(e) => setV({ ...v, especes: e.target.value })} /></Field>
        <Field label="Tickets resto €"><Input inputMode="decimal" value={v.ticketsResto} onChange={(e) => setV({ ...v, ticketsResto: e.target.value })} /></Field>
        <Field label="Autres €"><Input inputMode="decimal" value={v.autres} onChange={(e) => setV({ ...v, autres: e.target.value })} /></Field>
      </div>
      <p className="text-sm font-medium text-muted">Ventes TTC par taux de TVA (pour l&apos;onglet TVA)</p>
      <div className="grid grid-cols-3 items-end gap-2">
        <Field label="5,5 %"><Input inputMode="decimal" value={v.ttc55} onChange={(e) => setV({ ...v, ttc55: e.target.value })} /></Field>
        <Field label="10 %"><Input inputMode="decimal" value={v.ttc10} onChange={(e) => setV({ ...v, ttc10: e.target.value })} /></Field>
        <Field label="20 %"><Input inputMode="decimal" value={v.ttc20} onChange={(e) => setV({ ...v, ttc20: e.target.value })} /></Field>
      </div>
      <Field label="Note"><Input value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} /></Field>
      <ErrorBox message={error} />
      <Button type="submit" className="w-full">Enregistrer</Button>
    </form>
  );
}
