"use client";

import { doc, onSnapshot } from "firebase/firestore";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input } from "@/components/ui";
import { isCashDeposit, isUber } from "@/lib/cashImport";
import { db } from "@/lib/firebase";
import { formatEuros } from "@/lib/money";
import { moisCle } from "@/lib/reglages";
import type { BankLine, CashLine } from "@/lib/reconcile";
import { comparerCB, comparerUber, comparerUberBanque, comparerUberJour, pire, controleTotal, type Statut, type TicketZ } from "@/lib/ticketZ";
import type { BankTransaction, CashEntry, UberJourDoc, UberPayout, WithId } from "@/lib/types";

const fr = (iso: string) => iso.split("-").reverse().join("/");
/** « octobre 2026 ». */
const nomMois = (ym: string) => new Date(`${ym}-15T12:00:00`).toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
const hier = () => new Date(Date.now() - 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });
const lendemain = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

const TONS: Record<Statut, "green" | "red" | "orange" | "neutral"> = { ok: "green", proche: "orange", ecart: "red", attente: "orange", absent: "neutral" };
const MOTS: Record<Statut, string> = { ok: "OK", proche: "À vérifier", ecart: "Écart", attente: "En attente", absent: "Pas de données" };

const CATS: Record<string, string> = { cb: "CB", especes: "Espèces", uber: "Uber", ticketsResto: "Titres resto", autres: "Autre" };

/** Réduit une photo de ticket (souvent 4–8 Mo) avant l'envoi : 2000 px de haut suffisent pour lire les montants. */
async function enBase64(f: File): Promise<{ base64: string; mediaType: string }> {
  if (f.type.startsWith("image/")) {
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.85);
    return { base64: url.split(",")[1], mediaType: "image/jpeg" };
  }
  const buf = new Uint8Array(await f.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { base64: btoa(s), mediaType: f.type || "application/pdf" };
}

function Ligne({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right tabular-nums">{children}</span>
    </div>
  );
}

function Bloc({ titre, statut, children }: { titre: string; statut: Statut; children: ReactNode }) {
  return (
    <Card className={statut === "ecart" ? "border-danger/40" : ""}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="font-semibold">{titre}</div>
        <Badge tone={TONS[statut]}>{MOTS[statut]}</Badge>
      </div>
      <div className="space-y-1">{children}</div>
    </Card>
  );
}

export function JourAJour({
  cash,
  bank,
  uber,
  uberJours,
  maxFee,
  maxDays,
}: {
  cash: WithId<CashEntry>[];
  bank: WithId<BankTransaction>[];
  uber: WithId<UberPayout>[];
  uberJours: WithId<UberJourDoc>[];
  maxFee: number;
  maxDays: number;
}) {
  const { user } = useAuth();
  const { rid } = useRestaurant();
  // Dernier passage du robot L'Addition (automatique chaque matin, ou bouton).
  const [auto, setAuto] = useState<{
    le: number;
    mois?: string[];
    jours: number;
    zLus: number;
    zRestants?: number;
    echecs: string[];
    erreur?: string;
    diagnostic?: unknown;
  } | null>(null);
  const [recup, setRecup] = useState(false);
  const [copie, setCopie] = useState(false);
  useEffect(
    () =>
      onSnapshot(
        doc(db(), "restaurants", rid, "settings", "ticketsZ"),
        (d) => setAuto(d.exists() ? (d.data() as typeof auto) : null),
        () => setAuto(null),
      ),
    [rid],
  );
  const [jour, setJour] = useState(hier());
  const [lecture, setLecture] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const fichier = useRef<HTMLInputElement>(null);

  const entry = cash.find((c) => c.date === jour);
  const ticket: TicketZ | null = entry?.paiements
    ? {
        dateTicket: entry.ticketZ?.dateTicket ?? jour,
        heureCloture: entry.ticketZ?.heureCloture,
        paiements: entry.paiements.map((p) => ({ ...p, categorie: p.categorie as TicketZ["paiements"][number]["categorie"] })),
        total: entry.total,
      }
    : null;

  const toutes: BankLine[] = useMemo(
    () => bank.map((b) => ({ id: b.id, date: b.date, amount: b.montant, libelle: b.libelle })),
    [bank],
  );
  const credits = useMemo(() => toutes.filter((b) => b.amount > 0), [toutes]);
  const cb = useMemo(
    () =>
      comparerCB(
        jour,
        cash.map((c) => ({ id: c.id, date: c.date, amount: c.cb })),
        credits.filter((b) => !isCashDeposit(b.libelle) && !isUber(b.libelle)),
        { maxDays, maxFeeRate: maxFee / 100, lignes: toutes },
      ),
    [jour, cash, credits, toutes, maxDays, maxFee],
  );
  const uberDuJour = uberJours.find((u) => u.date === jour);
  const uberJourBrut = comparerUberJour({ montant: entry?.uber ?? 0, commandes: entry?.uberCommandes }, uberDuJour);
  // Jour au bord d'un export Uber : un écart peut venir des commandes manquantes, pas encore une alerte.
  const uberJour = uberDuJour?.partiel && uberJourBrut.statut === "ecart" ? { ...uberJourBrut, statut: "attente" as const } : uberJourBrut;
  const ubersCaisse: CashLine[] = cash.filter((c) => c.uber !== undefined).map((c) => ({ id: c.id, date: c.date, amount: c.uber ?? 0 }));
  const uberSemaine = comparerUber(jour, ubersCaisse, uber);
  const uberBanque = comparerUberBanque(
    uberSemaine.versement,
    credits.filter((b) => isUber(b.libelle)),
  );
  const total = ticket ? controleTotal(ticket) : null;

  async function recuperer() {
    if (!user) return;
    setErreur(null);
    setInfo(null);
    setRecup(true);
    try {
      const res = await fetch(`/api/laddition/services?r=${rid}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ mois: moisChoisi }),
      });
      const b = (await res.json().catch(() => ({}))) as { error?: string; erreur?: string; jours?: number; zLus?: number; zRestants?: number };
      if (!res.ok) throw new Error(b.erreur ?? b.error ?? `Erreur ${res.status}`);
      setInfo(
        `L'Addition, ${nomMois(moisChoisi)} : ${b.jours ?? 0} journée(s) à jour, ${b.zLus ?? 0} ticket(s) Z lu(s).` +
          (b.zRestants ? ` ${b.zRestants} journée(s) encore à lire : appuie à nouveau sur le bouton.` : ""),
      );
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setRecup(false);
    }
  }

  // Mois de la journée choisie (jamais un mois futur) : c'est celui que le bouton relève.
  const moisChoisi = jour.slice(0, 7) > moisCle(new Date()) ? moisCle(new Date()) : jour.slice(0, 7);

  async function copierJournal() {
    await navigator.clipboard.writeText(JSON.stringify(auto?.diagnostic, null, 2)).catch(() => {});
    setCopie(true);
    setTimeout(() => setCopie(false), 2000);
  }

  async function deposer(f?: File) {
    if (!f || !user) return;
    setErreur(null);
    setInfo(null);
    setLecture(true);
    try {
      const corps = await enBase64(f);
      const res = await fetch(`/api/ticket-z?r=${rid}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await user.getIdToken()}`, "content-type": "application/json" },
        body: JSON.stringify({ ...corps, jour }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; jour?: string; avertissement?: string };
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      if (data.jour) setJour(data.jour);
      setInfo(data.avertissement ?? `Ticket Z lu et rangé sur la journée du ${fr(data.jour ?? jour)}.`);
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setLecture(false);
      if (fichier.current) fichier.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[minmax(0,14rem)_auto_auto] sm:justify-start">
          <Field label="Journée de service">
            <Input type="date" value={jour} onChange={(e) => e.target.value && setJour(e.target.value)} />
          </Field>
          <Button onClick={recuperer} disabled={recup}>
            {recup ? "L'Addition en cours (1 à 4 min)…" : `Récupérer ${nomMois(moisChoisi).split(" ")[0]}`}
          </Button>
          <Button variant="secondary" onClick={() => fichier.current?.click()} disabled={lecture}>
            {lecture ? "Lecture du ticket…" : entry?.source === "ticketZ" ? "Redéposer le ticket Z" : "Déposer le ticket Z"}
          </Button>
        </div>
        <p className="text-xs text-muted">Ticket Z daté du {fr(lendemain(jour))} si la caisse ferme après minuit.</p>
      </div>
      <input ref={fichier} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => deposer(e.target.files?.[0])} />
      <Card className="space-y-2">
        <div className="min-w-0 text-sm">
          <div className="font-medium">Tickets Z récupérés automatiquement chaque matin</div>
          <div className={`text-xs ${auto?.erreur ? "text-danger" : "text-muted"}`}>
            {!auto
              ? "Pas encore de passage du robot L'Addition."
              : auto.erreur
                ? `Dernier essai le ${new Date(auto.le).toLocaleString("fr-FR")} : ${auto.erreur}`
                : `Dernier passage le ${new Date(auto.le).toLocaleString("fr-FR")}${auto.mois?.length ? ` (${auto.mois.map(nomMois).join(", ")})` : ""} : ${auto.jours} journée(s), ${auto.zLus} ticket(s) Z lu(s)${auto.echecs.length ? `, ${auto.echecs.length} non lu(s)` : ""}${auto.zRestants ? `, ${auto.zRestants} encore à lire` : ""}.`}
          </div>
        </div>
        {!auto?.erreur && Boolean(auto?.echecs.length) && (
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">
            {auto?.echecs.slice(0, 4).map((e, i) => (
              <li key={i} className="break-words">
                {e}
              </li>
            ))}
            {(auto?.echecs.length ?? 0) > 4 && <li>… et {(auto?.echecs.length ?? 0) - 4} autre(s)</li>}
          </ul>
        )}
        {Boolean(auto?.diagnostic) && (
          <details className="w-full text-xs">
            <summary className="cursor-pointer text-muted">Ce que le robot a vu (à transmettre pour corriger)</summary>
            <Button variant="secondary" className="mt-2" onClick={copierJournal}>
              {copie ? "Copié" : "Copier le journal"}
            </Button>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-control bg-bg p-2">{JSON.stringify(auto?.diagnostic, null, 2)}</pre>
          </details>
        )}
      </Card>
      <ErrorBox message={erreur} />
      {info && <p className="rounded-control bg-success-soft p-3 text-sm text-success">{info}</p>}

      {!entry ? (
        <Empty>
          Pas de ticket Z pour le {fr(jour)}. Dans L&apos;Addition : Comptabilité › CA/TVA › Paiement › Jour à jour, choisis le {fr(jour)}, télécharge le Ticket Z et dépose-le ici (PDF ou photo).
        </Empty>
      ) : (
        <>
          <Bloc titre={`Ticket Z · journée du ${fr(jour)}`} statut={total?.statut ?? "absent"}>
            {entry.ticketZ && (
              <p className="mb-1 text-xs text-muted">
                Ticket daté du {fr(entry.ticketZ.dateTicket)}
                {entry.ticketZ.heureCloture ? `, clôture à ${entry.ticketZ.heureCloture}` : ""}
              </p>
            )}
            {(ticket?.paiements ?? []).map((p, i) => (
              <Ligne key={i} label={`${p.libelle}${p.nombre !== undefined ? ` ×${p.nombre}` : ""} · ${CATS[p.categorie] ?? p.categorie}`}>
                {formatEuros(p.montant)}
              </Ligne>
            ))}
            {!ticket && (
              <>
                <Ligne label="CB">{formatEuros(entry.cb)}</Ligne>
                <Ligne label="Espèces">{formatEuros(entry.especes)}</Ligne>
                <Ligne label="Titres resto">{formatEuros(entry.ticketsResto)}</Ligne>
              </>
            )}
            {total && (
              <div className="mt-2 border-t border-border pt-2">
                <Ligne label="Somme des paiements">{formatEuros(total.somme)}</Ligne>
                {total.total !== undefined && <Ligne label="Total imprimé">{formatEuros(total.total)}</Ligne>}
                {total.statut === "ecart" && <p className="text-xs text-danger">Écart de {formatEuros(total.ecart ?? 0)} : une ligne a peut-être été mal lue, vérifie le ticket.</p>}
              </div>
            )}
          </Bloc>

          <Bloc titre="CB caisse ↔ banque" statut={cb.statut}>
            {cb.joursCouverts && cb.joursCouverts.length > 1 ? (
              <>
                {cb.joursCouverts.map((c) => (
                  <Ligne key={c.id} label={`CB caisse du ${fr(c.date)}`}>
                    {formatEuros(c.amount)}
                  </Ligne>
                ))}
                <Ligne label={`CB caisse (${cb.joursCouverts.length} journées)`}>{formatEuros(cb.caisse)}</Ligne>
              </>
            ) : (
              <Ligne label="CB du ticket Z">{formatEuros(cb.caisse)}</Ligne>
            )}
            {cb.banque ? (
              <>
                {cb.remises ? (
                  <>
                    <p className="pt-1 text-xs font-medium text-muted">Remises CB créditées le {fr(cb.banque.date)}</p>
                    {cb.remises.map((b) => (
                      <Ligne key={b.id} label={b.libelle.slice(0, 34)}>
                        {formatEuros(b.amount)}
                      </Ligne>
                    ))}
                    {cb.remises.length > 1 && <Ligne label="Total des remises">{formatEuros(cb.banque.montant)}</Ligne>}
                    <Ligne label="Écart">{formatEuros(cb.ecart ?? 0)}</Ligne>
                    {cb.voisin && (
                      <p className="text-xs text-muted">
                        Compensé par le crédit du {fr(cb.voisin.credit)} ({formatEuros(cb.voisin.ecart)}) : un paiement est passé sur le jour voisin.
                      </p>
                    )}
                    {cb.cumul && <Ligne label={`Écart cumulé depuis le ${fr(cb.cumul.depuis)}`}>{formatEuros(cb.cumul.ecart)}</Ligne>}
                    <p className="text-xs text-muted">
                      Les CB d&apos;une journée sont créditées le jour bancaire suivant (samedi soir et dimanche : le lundi). La date dans le libellé est celle de
                      l&apos;envoi par le TPE, pas celle du paiement.
                    </p>
                  </>
                ) : (
                  <>
                    <Ligne label={`Remise du ${fr(cb.banque.date)} (J+${cb.banque.jours})`}>{formatEuros(cb.banque.montant)}</Ligne>
                    <p className="truncate text-xs text-muted">{cb.banque.libelle}</p>
                    <Ligne label="Écart (commission)">
                      {formatEuros(cb.ecart ?? 0)}
                      {cb.caisse ? ` · ${((-(cb.ecart ?? 0) / cb.caisse) * 100).toFixed(2)} %` : ""}
                    </Ligne>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-muted">
                  {cb.statut === "attente"
                    ? "Remise pas encore trouvée : elle arrive en général à J+1 / J+3, ou le relevé n'est pas encore importé."
                    : cb.statut === "absent"
                      ? "Pas de CB sur ce ticket."
                      : `Aucune remise entre ${maxFee} % de commission et le montant exact, dans les ${maxDays} jours.`}
                </p>
                {cb.candidats.length > 0 && (
                  <div className="mt-1">
                    <p className="text-xs font-medium text-muted">Crédits en banque des jours suivants :</p>
                    {cb.candidats.slice(0, 8).map((b) => (
                      <Ligne key={b.id} label={`${fr(b.date)} · ${b.libelle.slice(0, 28)}`}>{formatEuros(b.amount)}</Ligne>
                    ))}
                  </div>
                )}
              </>
            )}
          </Bloc>

          <Bloc titre="Uber caisse ↔ Uber Eats (jour)" statut={uberJour.statut}>
            <Ligne label="Uber du ticket Z">
              {entry.uberCommandes !== undefined ? `${entry.uberCommandes} cmd · ` : ""}
              {formatEuros(entry.uber ?? 0)}
            </Ligne>
            {uberJour.uber ? (
              <>
                <Ligne label="Uber Eats ce jour">
                  {uberJour.uber.commandes} cmd · {formatEuros(uberJour.uber.ventes)}
                </Ligne>
                {uberDuJour?.partiel && (
                  <p className="text-xs text-muted">Jour en bord d&apos;export Uber : importe aussi la période voisine pour avoir toutes ses commandes.</p>
                )}
                {uberJour.statut === "ecart" && (
                  <p className="text-xs text-danger">
                    {uberJour.ecartCommandes ? `${uberJour.ecartCommandes > 0 ? "+" : ""}${uberJour.ecartCommandes} commande(s) côté Uber. ` : ""}
                    {uberJour.ecartMontant ? `Écart de ${formatEuros(uberJour.ecartMontant)}.` : ""}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">Commandes Uber du jour pas encore importées (bouton « Importer commandes Uber »).</p>
            )}
          </Bloc>

          <Bloc titre="Uber de la semaine : L'Addition ↔ mail Uber ↔ banque" statut={uberSemaine.versement ? pire(uberSemaine.statut, uberBanque.statut) : uberSemaine.statut}>
            <Ligne label={`L'Addition, Z du ${fr(uberSemaine.semaine.debut)} au ${fr(uberSemaine.semaine.fin)}`}>
              {formatEuros(uberSemaine.caisseSemaine)} ({uberSemaine.joursSaisis}/7 j)
            </Ligne>
            {uberSemaine.versement ? (
              <>
                <Ligne label={`Mail Uber du ${fr(uberSemaine.versement.date)} · ventes`}>
                  {uberSemaine.versement.brut !== undefined ? formatEuros(uberSemaine.versement.brut) : "non indiquées"}
                </Ligne>
                {uberSemaine.ecart !== undefined && uberSemaine.ecart !== 0 && (
                  <p className={`text-xs ${uberSemaine.statut === "ecart" ? "text-danger" : "text-muted"}`}>
                    Écart ventes Uber − L&apos;Addition : {formatEuros(uberSemaine.ecart)}
                    {uberSemaine.joursSaisis < 7 ? ` (il manque ${7 - uberSemaine.joursSaisis} ticket(s) Z cette semaine)` : ""}
                    {uberSemaine.statut === "proche" ? " : petit écart, sans doute les commandes passées entre minuit et la fermeture, qu'Uber compte dans l'autre semaine." : ""}
                  </p>
                )}
                <Ligne label="Mail Uber · net versé">{formatEuros(uberSemaine.versement.montant)}</Ligne>
                {uberBanque.virement ? (
                  <Ligne label={`Banque le ${fr(uberBanque.virement.date)}`}>{formatEuros(uberBanque.virement.amount)}</Ligne>
                ) : (
                  <p className={`text-xs ${uberBanque.statut === "ecart" ? "text-danger" : "text-muted"}`}>
                    {uberBanque.statut === "ecart"
                      ? "Aucun virement UBER de ce montant en banque."
                      : "Virement pas encore arrivé ou relevé pas encore importé."}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted">Mail de versement Uber de cette semaine pas encore reçu (récap du lundi, validé dans « À vérifier »).</p>
            )}
          </Bloc>

          <Card>
            <div className="mb-1 font-semibold">Espèces</div>
            <Ligne label="Espèces du ticket Z">{formatEuros(entry.especes)}</Ligne>
            <p className="mt-1 text-xs text-muted">Les dépôts couvrent souvent plusieurs jours : voir l&apos;onglet Espèces.</p>
          </Card>
        </>
      )}
    </div>
  );
}
