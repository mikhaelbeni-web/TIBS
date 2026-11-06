"use client";

import { deleteDoc, doc, getDoc, setDoc, writeBatch } from "firebase/firestore";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Sheet } from "@/components/ui";
import { BanqueCard } from "@/components/BanqueCard";
import { JourAJour } from "@/components/JourAJour";
import { bankDocId, isCashDeposit, isUber, rowToUber, rowsToCash, rowsToUberJours } from "@/lib/cashImport";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { lignesXlsx, lireExportServices } from "@/lib/ladditionExport";
import { db } from "@/lib/firebase";
import { readSpreadsheet, rowToBank } from "@/lib/importer";
import { apparierImports, sansDoublonsImport } from "@/lib/banque";
import { formatEuros, toCents } from "@/lib/money";
import { reconcile, reconcileDeposits, type BankLine, type CashLine } from "@/lib/reconcile";
import { pointageMoisCB, type Statut } from "@/lib/ticketZ";
import type { BankTransaction, CashEntry, UberJourDoc, UberPayout, WithId } from "@/lib/types";
import { useCollection } from "@/lib/useCollection";

const fr = (iso: string) => iso.split("-").reverse().join("/");
const thisMonth = () => new Date().toISOString().slice(0, 7);
const TONS_CB: Record<Statut, "green" | "red" | "orange" | "neutral"> = { ok: "green", proche: "orange", ecart: "red", attente: "orange", absent: "neutral" };

function monthBounds(mois: string, extraDays: number) {
  const [y, m] = mois.split("-").map(Number);
  const start = `${mois}-01`;
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const endPlus = new Date(Date.UTC(y, m, 0) + extraDays * 86400000).toISOString().slice(0, 10);
  return { start, end, endPlus };
}

export default function RapprochementPage() {
  const { rid } = useRestaurant();
  const cash = useCollection<CashEntry>("cashEntries", "date");
  const bank = useCollection<BankTransaction>("bankTransactions", "date");
  const uber = useCollection<UberPayout>("uberPayouts", "date");
  const uberJours = useCollection<UberJourDoc>("uberJours", "date");
  const [mois, setMois] = useState(thisMonth());
  const [tab, setTab] = useState<"jour" | "cb" | "especes" | "uber" | "banque">("jour");
  const [maxFee, setMaxFee] = useState("3");
  const [maxDays, setMaxDays] = useState("5");
  const [adding, setAdding] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const cashFile = useRef<HTMLInputElement>(null);
  const bankFile = useRef<HTMLInputElement>(null);
  const uberFile = useRef<HTMLInputElement>(null);
  const uberJoursFile = useRef<HTMLInputElement>(null);
  const servicesFile = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  /** Liens des tickets Z de l'export importé : gardés en mémoire seulement (signés, ils expirent). */
  const [zATraiter, setZATraiter] = useState<{ jour: string; url: string }[]>([]);
  const [lectureZ, setLectureZ] = useState<string | null>(null);

  const { start, end, endPlus } = monthBounds(mois, 14);
  const days = useMemo(() => cash.items.filter((c) => c.date >= start && c.date <= end), [cash.items, start, end]);
  const credits = useMemo(
    () => bank.items.filter((b) => b.date >= start && b.date <= endPlus && b.montant > 0),
    [bank.items, start, endPlus],
  );
  const monthBank = useMemo(() => bank.items.filter((b) => b.date >= start && b.date <= end), [bank.items, start, end]);

  // CB : même règle que « Jour à jour » (remises d'un jour de crédit comparées ensemble aux journées qu'elles couvrent).
  const cbCaisse: CashLine[] = useMemo(() => cash.items.map((d) => ({ id: d.id, date: d.date, amount: d.cb })), [cash.items]);
  const toutesLignes: BankLine[] = useMemo(
    () => bank.items.map((b) => ({ id: b.id, date: b.date, amount: b.montant, libelle: b.libelle, ...(b.valeur ? { valeur: b.valeur } : {}) })),
    [bank.items],
  );
  const cb = useMemo(
    () =>
      pointageMoisCB(
        mois,
        cbCaisse,
        toutesLignes.filter((b) => b.amount > 0 && !isCashDeposit(b.libelle) && !isUber(b.libelle)),
        { maxDays: Number(maxDays) || 5, maxFeeRate: (Number(maxFee.replace(",", ".")) || 0) / 100, lignes: toutesLignes },
      ),
    [mois, cbCaisse, toutesLignes, maxDays, maxFee],
  );

  const esp = useMemo(() => {
    const cashLines: CashLine[] = days.map((d) => ({ id: d.id, date: d.date, amount: d.especes }));
    const deposits: BankLine[] = credits
      .filter((b) => isCashDeposit(b.libelle))
      .map((b) => ({ id: b.id, date: b.date, amount: b.montant, libelle: b.libelle, ...(b.valeur ? { valeur: b.valeur } : {}) }));
    return reconcileDeposits(cashLines, deposits, { maxDays: 14, tolerance: 0 });
  }, [days, credits]);

  const ub = useMemo(() => {
    const payouts: CashLine[] = uber.items
      .filter((u) => u.date >= start && u.date <= end)
      .map((u) => ({ id: u.id, date: u.date, amount: u.montant }));
    const virements: BankLine[] = credits
      .filter((b) => isUber(b.libelle))
      .map((b) => ({ id: b.id, date: b.date, amount: b.montant, libelle: b.libelle, ...(b.valeur ? { valeur: b.valeur } : {}) }));
    // Montants nets des deux côtés : égalité au centime, virement entre J-2 et J+5.
    return reconcile(payouts, virements, { minDays: -2, maxDays: 5, maxFeeRate: 0, tolerance: 1 });
  }, [uber.items, credits, start, end]);
  const uberById = new Map(uber.items.map((u) => [u.id, u]));

  const totalCbCaisse = days.reduce((s, d) => s + d.cb, 0);
  const totalCbBanque = cb.groupes.reduce((s, g) => s + (g.banque?.montant ?? 0), 0);
  const totalEsp = days.reduce((s, d) => s + d.especes, 0);
  const totalEspDeposes = esp.matches.reduce((s, m) => s + m.deposit.amount, 0);

  async function importCash(f?: File) {
    if (!f) return;
    setOpError(null);
    try {
      const drafts = rowsToCash(await readSpreadsheet(f));
      if (!drafts.length) throw new Error("Aucune journée reconnue. Colonnes attendues : Date, CB, Espèces, Tickets resto, Autres (et TTC 5,5 / TTC 10 / TTC 20 pour la TVA).");
      const batch = writeBatch(db());
      drafts.forEach((d) => batch.set(doc(db(), "restaurants", rid, "cashEntries", d.date), { ...d, createdAt: Date.now() }));
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
        batch.set(doc(db(), "restaurants", rid, "uberPayouts", `${key}_${n}`), { ...r, createdAt: Date.now() });
      }
      await batch.commit();
      setInfo(`${rows.length} versement(s) Uber Eats importé(s).`);
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      if (uberFile.current) uberFile.current.value = "";
    }
  }

  /** Export « Détails par service » de L'Addition : CB, espèces, Uber et TTC par taux, une journée par service. */
  async function importServices(f?: File) {
    if (!f) return;
    setOpError(null);
    try {
      const exp = lireExportServices(await lignesXlsx(await f.arrayBuffer()));
      if (!exp.services.length) throw new Error("Aucun service trouvé dans ce fichier.");
      const parJour = new Map<string, { cb: number; especes: number; uber: number; ttc10: number; ttc20: number; ttc55: number; caTtcNet: number }>();
      const liens: { jour: string; url: string }[] = [];
      for (const sv of exp.services) {
        const d = parJour.get(sv.jour) ?? { cb: 0, especes: 0, uber: 0, ttc10: 0, ttc20: 0, ttc55: 0, caTtcNet: 0 };
        d.cb += sv.cb;
        d.especes += sv.cash;
        d.uber += sv.uber;
        d.ttc10 += sv.ttc10;
        d.ttc20 += sv.ttc20;
        d.ttc55 += sv.ttc55;
        d.caTtcNet += sv.caTtcNet;
        parJour.set(sv.jour, d);
        if (sv.zUrl) liens.push({ jour: sv.jour, url: sv.zUrl });
      }
      const existants = new Set(cash.items.map((c) => c.date));
      const batch = writeBatch(db());
      for (const [jour, d] of parJour) {
        // Fusion : on ne touche pas au détail lu sur un ticket Z (paiements, nombre de commandes Uber).
        batch.set(
          doc(db(), "restaurants", rid, "cashEntries", jour),
          { date: jour, ...d, ...(existants.has(jour) ? {} : { ticketsResto: 0, autres: 0, source: "import", createdAt: Date.now() }), servicesLAddition: Date.now() },
          { merge: true },
        );
      }
      await batch.commit();
      setZATraiter(liens);
      setInfo(
        `${parJour.size} journée(s) L'Addition importée(s) (CB, espèces, Uber, TTC par taux).` +
          (liens.length ? ` Lis maintenant les ${liens.length} tickets Z pour avoir le nombre de commandes Uber de chaque jour.` : ""),
      );
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      if (servicesFile.current) servicesFile.current.value = "";
    }
  }

  /** Fait lire chaque ticket Z de l'export par le serveur (téléchargé tout de suite, lu par l'IA). */
  async function lireTicketsZ() {
    if (!user || !zATraiter.length) return;
    setOpError(null);
    const restants = [...zATraiter];
    const echecs: string[] = [];
    let lus = 0;
    for (const z of zATraiter) {
      setLectureZ(`Lecture du Z du ${fr(z.jour)} (${lus + echecs.length + 1}/${zATraiter.length})…`);
      try {
        const res = await fetch(`/api/ticket-z?r=${rid}`, {
          method: "POST",
          headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json" },
          body: JSON.stringify({ url: z.url, jour: z.jour }),
        });
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          echecs.push(`${fr(z.jour)} : ${data.error ?? res.status}`);
          // Budget atteint ou lecture désactivée : inutile de continuer.
          if (res.status === 429 || res.status === 503) break;
          continue;
        }
        lus++;
        restants.splice(restants.indexOf(z), 1);
      } catch (e) {
        echecs.push(`${fr(z.jour)} : ${(e as Error).message}`);
      }
    }
    setLectureZ(null);
    setZATraiter(restants);
    setInfo(`${lus} ticket(s) Z lu(s).`);
    if (echecs.length) setOpError(`Tickets Z non lus : ${echecs.slice(0, 5).join(" ; ")}${echecs.length > 5 ? "…" : ""}`);
  }

  async function importUberJours(f?: File) {
    if (!f) return;
    setOpError(null);
    try {
      const jours = rowsToUberJours(await readSpreadsheet(f));
      if (!jours.length) throw new Error("Aucune commande reconnue. Colonnes attendues : Date de la commande (avec l'heure si possible), Ventes TTC (et Statut).");
      const batch = writeBatch(db());
      let gardes = 0;
      for (const j of jours) {
        const ref = doc(db(), "restaurants", rid, "uberJours", j.date);
        // Jour au bord de l'export : il lui manque des commandes, on ne remplace pas une journée complète déjà importée.
        if (j.partiel) {
          const ex = await getDoc(ref);
          if (ex.exists() && !ex.get("partiel")) {
            gardes++;
            continue;
          }
        }
        batch.set(ref, { ...j, createdAt: Date.now() });
      }
      await batch.commit();
      setInfo(
        `Commandes Uber Eats de ${jours.length - gardes} jour(s) importées.` +
          (gardes ? ` ${gardes} jour(s) en bord d'export déjà complets ont été gardés.` : "") +
          (jours.some((j) => j.partiel) ? " Le premier et le dernier jour sont marqués incomplets jusqu'à l'import de la période voisine." : ""),
      );
    } catch (e) {
      setOpError((e as Error).message);
    } finally {
      if (uberJoursFile.current) uberJoursFile.current.value = "";
    }
  }

  async function importBank(f?: File) {
    if (!f) return;
    setOpError(null);
    try {
      const lues = (await readSpreadsheet(f)).map(rowToBank).filter((r) => r !== null);
      if (!lues.length) throw new Error("Aucune opération reconnue. Colonnes attendues : Date, Libellé, Montant (ou Débit / Crédit).");
      // Opérations déjà relevées automatiquement (DSP2) : on ne les réimporte pas depuis le fichier.
      const rows = sansDoublonsImport(lues, bank.items.filter((b) => b.source === "banque"));
      const dejaReleves = lues.length - rows.length;
      const importId = `${Date.now()}`;
      const seen = new Map<string, number>();
      // Firestore limite un lot à 500 écritures.
      for (let i = 0; i < rows.length; i += 450) {
        const batch = writeBatch(db());
        for (const r of rows.slice(i, i + 450)) {
          const key = `${r.date}|${r.montant}|${r.libelle}`;
          const n = seen.get(key) ?? 0;
          seen.set(key, n + 1);
          batch.set(doc(db(), "restaurants", rid, "bankTransactions", bankDocId(r.date, r.montant, r.libelle, n)), { ...r, importId, createdAt: Date.now() });
        }
        await batch.commit();
      }
      // La banque n'envoie pas la date de valeur par le relevé automatique : le fichier la donne aux opérations déjà
      // présentes (même montant, même jour à un jour près). Elle sert à rattacher les remises CB du matin à la veille.
      const sansValeur = bank.items.filter((b) => b.source === "banque" && !b.valeur).map((b) => ({ id: b.id, date: b.date, montant: b.montant, libelle: b.libelle }));
      const valeurs = [...apparierImports(lues.filter((r) => r.valeur), sansValeur, 1)];
      for (let i = 0; i < valeurs.length; i += 450) {
        const batch = writeBatch(db());
        for (const [id, r] of valeurs.slice(i, i + 450)) batch.update(doc(db(), "restaurants", rid, "bankTransactions", id), { valeur: r.valeur });
        await batch.commit();
      }
      setInfo(
        `${rows.length} opération(s) bancaire(s) importée(s). Les doublons d'un précédent import sont ignorés.${dejaReleves ? ` ${dejaReleves} déjà présente(s) grâce au relevé automatique.` : ""}${valeurs.length ? ` Date de valeur ajoutée à ${valeurs.length} opération(s).` : ""}`,
      );
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
            <Button variant="secondary" onClick={() => uberFile.current?.click()}>Importer versements Uber</Button>
            <Button variant="secondary" onClick={() => uberJoursFile.current?.click()}>Importer commandes Uber</Button>
            <Button variant="secondary" onClick={() => servicesFile.current?.click()}>Importer services L&apos;Addition</Button>
            <Button onClick={() => setAdding(true)}>+ Journée</Button>
          </>
        }
      />
      <input ref={cashFile} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => importCash(e.target.files?.[0])} />
      <input ref={bankFile} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => importBank(e.target.files?.[0])} />
      <input ref={servicesFile} type="file" accept=".xlsx" className="hidden" onChange={(e) => importServices(e.target.files?.[0])} />
      <input ref={uberJoursFile} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => importUberJours(e.target.files?.[0])} />
      <input ref={uberFile} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => importUber(e.target.files?.[0])} />

      <BanqueCard />

      <div className="mb-4 grid grid-cols-2 items-end gap-2 sm:max-w-xl sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <Field label="Mois"><Input type="month" value={mois} onChange={(e) => setMois(e.target.value || thisMonth())} /></Field>
        </div>
        <Field label="Commission CB max %"><Input inputMode="decimal" value={maxFee} onChange={(e) => setMaxFee(e.target.value)} /></Field>
        <Field label="Délai max (jours)"><Input inputMode="numeric" value={maxDays} onChange={(e) => setMaxDays(e.target.value)} /></Field>
      </div>

      <ErrorBox message={cash.error || bank.error || uber.error || uberJours.error || opError} />
      {info && <p className="mb-3 rounded-control bg-success-soft p-3 text-sm text-success">{info}</p>}
      {zATraiter.length > 0 && (
        <Card className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">
            {lectureZ ?? `${zATraiter.length} ticket(s) Z à lire depuis L'Addition (nombre de commandes Uber, détail des paiements).`}
          </span>
          <Button onClick={lireTicketsZ} disabled={!!lectureZ}>{lectureZ ? "Lecture…" : "Lire les tickets Z"}</Button>
        </Card>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card><div className="text-xs text-muted">CB caisse</div><div className="text-lg font-semibold tabular-nums">{formatEuros(totalCbCaisse)}</div></Card>
        <Card>
          <div className="text-xs text-muted">CB pointée en banque</div>
          <div className="text-lg font-semibold tabular-nums">{formatEuros(totalCbBanque)}</div>
          <div className="text-xs text-muted">{cb.sansRemise.length} jour(s) non pointé(s)</div>
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

      <div className="mb-4 grid grid-cols-3 gap-2 sm:flex">
        <Button variant={tab === "jour" ? "primary" : "secondary"} onClick={() => setTab("jour")}>Jour à jour</Button>
        <Button variant={tab === "cb" ? "primary" : "secondary"} onClick={() => setTab("cb")}>CB</Button>
        <Button variant={tab === "especes" ? "primary" : "secondary"} onClick={() => setTab("especes")}>Espèces</Button>
        <Button variant={tab === "uber" ? "primary" : "secondary"} onClick={() => setTab("uber")}>Uber</Button>
        <Button variant={tab === "banque" ? "primary" : "secondary"} onClick={() => setTab("banque")}>Relevé</Button>
      </div>

      {cash.loading || bank.loading || uber.loading || uberJours.loading ? (
        <p className="text-muted">Chargement…</p>
      ) : tab === "jour" ? (
        <JourAJour
          cash={cash.items}
          bank={bank.items}
          uber={uber.items}
          uberJours={uberJours.items}
          maxFee={Number(maxFee.replace(",", ".")) || 0}
          maxDays={Number(maxDays) || 5}
        />
      ) : tab === "cb" ? (
        <div className="space-y-4">
          {days.length === 0 && <Empty>Aucune journée de caisse ce mois-ci. Importez votre export ou ajoutez une journée.</Empty>}
          <ul className="space-y-2">
            {cb.groupes.map((g) => {
              const jours = g.joursCouverts ?? [];
              const ecart = g.ecart ?? 0;
              return (
                <li key={`${g.banque?.date}-${jours[0]?.date ?? ""}`}>
                  <Card className="space-y-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-medium">
                          Caisse du {jours.length ? jours.map((j) => fr(j.date).slice(0, 5)).join(" + ") : fr(g.banque?.date ?? "")} · {formatEuros(g.caisse)}
                        </div>
                        <div className="text-sm text-muted">
                          Banque le {fr(g.banque?.date ?? "")} · {formatEuros(g.banque?.montant ?? 0)}
                          {g.remises ? ` · ${g.remises.length} remise${g.remises.length > 1 ? "s" : ""}` : ` · ${g.banque?.libelle ?? ""}`}
                          {g.remises?.some((b) => b.valeur && b.valeur < b.date) ? " (dont lots du matin)" : ""}
                        </div>
                      </div>
                      <Badge tone={TONS_CB[g.statut]}>{Math.abs(ecart) <= 100 ? "OK" : formatEuros(ecart)}</Badge>
                    </div>
                    {g.voisin && <p className="text-xs text-muted">Compensé par le crédit du {fr(g.voisin.credit)} ({formatEuros(g.voisin.ecart)}).</p>}
                    {g.sansRemise && <p className="text-xs text-muted">Petit manque en remise CB : paiement saisi « CB » en caisse et non passé au TPE, à vérifier.</p>}
                  </Card>
                </li>
              );
            })}
          </ul>
          {cb.sansRemise.length > 0 && (
            <Card className="border-danger/30">
              <div className="mb-2 font-medium text-danger">Jours de caisse sans remise CB trouvée</div>
              <ul className="space-y-1 text-sm">
                {cb.sansRemise.map(({ jour, statut }) => (
                  <li key={jour.id} className="flex justify-between gap-2">
                    <span>{fr(jour.date)}{statut === "attente" ? " · en attente" : ""}</span>
                    <span className="tabular-nums">{formatEuros(jour.amount)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">
                Causes fréquentes : remise pas encore créditée, relevé pas encore à jour, transaction annulée en caisse.
              </p>
            </Card>
          )}
          {cb.remisesSeules.length > 0 && (
            <Card className="border-warning/30">
              <div className="mb-2 font-medium text-warning">Remises CB sans journée de caisse</div>
              <ul className="space-y-1 text-sm">
                {cb.remisesSeules.map((b) => (
                  <li key={b.id} className="flex justify-between gap-2">
                    <span className="truncate">{fr(b.date)} · {b.libelle}</span>
                    <span className="shrink-0 tabular-nums">{formatEuros(b.amount)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Journée de caisse pas encore relevée dans L&apos;Addition, ou restaurant fermé ce jour-là.</p>
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
            <Empty>Aucune opération relevée pour ce mois.</Empty>
          ) : (
            <ul className="divide-y divide-border rounded-card border border-border bg-surface">
              {monthBank.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 p-3 text-sm">
                  <div className="min-w-0">
                    <div className="truncate">{b.libelle}</div>
                    <div className="text-xs text-muted">{fr(b.date)}{b.source === "banque" ? "" : " · import"}</div>
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
                <Button variant="ghost" onClick={() => confirm(`Supprimer la journée du ${fr(d.date)} ?`) && deleteDoc(doc(db(), "restaurants", rid, "cashEntries", d.id))}>
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
  const { rid } = useRestaurant();
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
      await setDoc(doc(db(), "restaurants", rid, "cashEntries", date), data);
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
