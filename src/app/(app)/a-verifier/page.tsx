"use client";

import { collection, doc, getDocs, onSnapshot, query, where, writeBatch } from "firebase/firestore";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { PdfApercu } from "@/components/PdfApercu";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Sheet } from "@/components/ui";
import { useRestaurant } from "@/components/RestaurantProvider";
import { isRestaurantId, restaurant, type RestaurantId } from "@/lib/restaurants";
import { db } from "@/lib/firebase";
import type { InboxDoc, InboxItem } from "@/lib/ingest";
import { formatEuros, toCents } from "@/lib/money";
import { parseReglages } from "@/lib/reglages";
import { useCollection } from "@/lib/useCollection";

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
const euros = (c?: number) => (c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));
const gmailLink = (id: string, mailbox?: string) =>
  `https://mail.google.com/mail/${mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : ""}#all/${id}`;

/** Jour de réception du mail (heure de Paris), AAAA-MM-JJ. */
function jourRecu(d: InboxDoc): string {
  const t = d.item.source.receivedAt ? Date.parse(d.item.source.receivedAt) : d.receivedAt;
  return Number.isFinite(t) ? new Date(t).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" }) : "";
}

const isoJour = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });

/** Raccourcis de période : bornes AAAA-MM-JJ calculées au moment du clic. */
function raccourcis(): { label: string; du: string; au: string }[] {
  const auj = new Date();
  const [y, m] = isoJour(auj).split("-").map(Number);
  const debut = (yy: number, mm: number) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  const finMois = (yy: number, mm: number) => isoJour(new Date(Date.UTC(yy, mm, 0, 12)));
  const pm = m === 1 ? 12 : m - 1;
  const py = m === 1 ? y - 1 : y;
  return [
    { label: "Ce mois-ci", du: debut(y, m), au: isoJour(auj) },
    { label: "Mois dernier", du: debut(py, pm), au: finMois(py, pm) },
    { label: "30 derniers jours", du: isoJour(new Date(auj.getTime() - 29 * 86_400_000)), au: isoJour(auj) },
  ];
}

/** Bandeau de période, en haut de la page : filtre la liste et limite « Relever ». */
function PeriodeBar({ du, au, onChange }: { du: string; au: string; onChange: (du: string, au: string) => void }) {
  const choix = raccourcis();
  return (
    <Card className="mb-4 space-y-3">
      <div className="font-semibold">Période des mails</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Reçus du">
          <Input type="date" value={du} max={au || undefined} onChange={(e) => onChange(e.target.value, au)} />
        </Field>
        <Field label="au">
          <Input type="date" value={au} min={du || undefined} onChange={(e) => onChange(du, e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        {choix.map((c) => (
          <Button key={c.label} variant={c.du === du && c.au === au ? "primary" : "secondary"} className="min-h-11 px-3 text-sm" onClick={() => onChange(c.du, c.au)}>
            {c.label}
          </Button>
        ))}
        <Button variant={!du && !au ? "primary" : "ghost"} className="min-h-11 px-3 text-sm" onClick={() => onChange("", "")}>
          Toutes les dates
        </Button>
      </div>
    </Card>
  );
}

/** Boîte Gmail d'où vient l'élément : pastille de couleur du restaurant + adresse. */
function Boite({ boite, adresse, className = "" }: { boite?: RestaurantId; adresse?: string; className?: string }) {
  if (!boite) return null;
  const r = restaurant(boite);
  return (
    <div className={`flex min-w-0 items-center gap-1.5 text-xs text-muted ${className}`}>
      <span className={`size-2 shrink-0 rounded-full ${r.couleur}`} aria-hidden />
      <span className="truncate">
        Mail {r.court} · {adresse || r.boiteMail}
      </span>
    </div>
  );
}

interface MailStatus {
  adresse?: string;
  connecteLe?: number;
  dernierPassage?: number;
  dernierEssai?: number;
  erreur?: string;
  reglages?: unknown;
  dernierResultat?: { nouveaux: number; messagesVus: number; erreurs: number; incomplet: boolean; lecturePdf?: boolean };
}

const RETOUR_GMAIL: Record<string, string> = {
  ok: "Boîte Gmail connectée. Lance « Vérifier maintenant » pour le premier relevé.",
  refuse: "Connexion annulée sur la page Google.",
  lien_expire: "Le lien de connexion a expiré, recommence.",
  droits_manquants: "Coche bien l'accès en lecture à Gmail sur la page Google.",
  pas_de_jeton: "Google n'a pas donné d'accès durable : retire l'app dans ton compte Google (Sécurité > Applications tierces) puis reconnecte.",
  erreur: "La connexion a échoué. Vérifie les identifiants Google dans Vercel.",
};

function frequence(raw: unknown) {
  const r = parseReglages(raw);
  if (!r.releveAuto) return "coupé (voir Réglages)";
  return r.frequenceHeures === 24 ? "une fois par jour" : r.frequenceHeures === 1 ? "toutes les heures" : `toutes les ${r.frequenceHeures} h`;
}

function dateTime(ms?: number) {
  return ms ? new Date(ms).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "jamais";
}

async function api(user: { getIdToken: () => Promise<string> }, path: string) {
  const res = await fetch(path, { method: "POST", headers: { authorization: `Bearer ${await user.getIdToken()}` } });
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(json.error || json.message || `Erreur ${res.status}${text ? ` : ${text.slice(0, 200)}` : ""}`);
  return json;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function texteRelu(r: any, bouton = false) {
  if (!r.relus && !r.restants) return bouton ? "Aucun PDF à lire : tout est déjà rempli." : "";
  const limite = r.limite === "budget" ? " Budget du mois atteint (voir Réglages)." : r.limite === "max" ? " Limite de PDF par passage atteinte : relance pour continuer." : "";
  const cout = typeof r.coutUsd === "number" && r.coutUsd > 0 ? ` Coût : ${r.coutUsd.toFixed(2).replace(".", ",")} $.` : "";
  return `PDF lus par l'IA : ${r.relus}, dont ${r.completes} rempli(s).${r.restants ? ` Encore ${r.restants} à compléter.` : ""}${limite}${cout}`;
}

const RAISON_LECTURE: Record<string, string> = {
  limite: "PDF pas encore lu : la limite de PDF par relevé était atteinte. Touche « Lire ce PDF avec l'IA ».",
  budget: "PDF pas lu : le budget IA du mois est atteint (voir Réglages).",
  desactivee: "PDF pas lu : la lecture par l'IA est coupée (voir Réglages).",
  pas_facture: "L'IA n'a pas reconnu une facture dans ce PDF. Vérifie avec « Voir la facture ».",
  pas_de_pdf: "Aucun PDF lisible dans ce mail.",
  erreur: "La lecture par l'IA a échoué.",
};

/** Carte « Boîte mail » : connexion Gmail, dernier relevé, bouton pour relever tout de suite. */
function MailCard({ du, au }: { du: string; au: string }) {
  const { rid, current, setRid } = useRestaurant();
  const { user } = useAuth();
  const params = useSearchParams();
  const retour = params.get("gmail");
  const retourRid = params.get("r");

  // Retour de Google : on se place sur le restaurant dont on vient de connecter la boîte.
  useEffect(() => {
    if (isRestaurantId(retourRid) && retourRid !== rid) setRid(retourRid);
  }, [retourRid, rid, setRid]);
  const [status, setStatus] = useState<MailStatus | null>(null);
  const [busy, setBusy] = useState<"connect" | "sync" | "lire" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => onSnapshot(doc(db(), "restaurants", rid, "settings", "mail"), (s) => setStatus((s.data() as MailStatus) ?? {}), (e) => setError(e.message)), [rid]);

  async function run(kind: "connect" | "sync" | "lire" | "disconnect") {
    if (!user) return;
    setBusy(kind);
    setError(null);
    setInfo(null);
    try {
      if (kind === "connect") {
        const { url } = await api(user, `/api/gmail/connect?r=${rid}`);
        window.location.assign(url);
        return;
      }
      if (kind === "lire") {
        const { relu } = await api(user, `/api/gmail/sync?r=${rid}&mode=lire`);
        setInfo(relu.status === "ok" ? texteRelu(relu, true) : relu.message);
        return;
      }
      if (kind === "sync" && Boolean(du) !== Boolean(au)) throw new Error("Choisis la date de début et la date de fin, ou touche « Toutes les dates ».");
      if (kind === "disconnect" && !confirm("Déconnecter la boîte mail ? Les relevés automatiques s'arrêtent.")) return;
      const filtre = kind === "sync" && du && au ? `&du=${du}&au=${au}` : "";
      const r = await api(user, `/api/gmail/${kind === "sync" ? "sync" : "disconnect"}?r=${rid}${filtre}`);
      if (kind === "sync") {
        setInfo(
          r.status === "ok"
            ? `${filtre ? `Du ${fr(du)} au ${fr(au)} : ` : ""}${r.messagesVus} mail(s) lu(s), ${r.nouveaux} élément(s) ajouté(s)${r.releves ? `, ${r.releves} relevé(s) fournisseur rangé(s) dans Factures` : ""}.${r.incomplet ? " Il en reste : relance pour continuer." : ""}`
            : r.message,
        );
        if (r.relu?.status === "ok" && r.relu.relus) setInfo((i) => `${i ?? ""} ${texteRelu(r.relu)}`.trim());
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const connected = Boolean(status?.adresse);
  return (
    <Card className="mb-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold">Boîte mail · {current.court}</div>
          <div className="truncate text-sm text-muted">{connected ? status!.adresse : `À connecter : ${current.boiteMail}`}</div>
        </div>
        {status && <Badge tone={status.erreur ? "red" : connected ? "green" : "neutral"}>{status.erreur ? "À reconnecter" : connected ? "Connectée" : "Non connectée"}</Badge>}
      </div>
      {connected && (
        <p className="text-sm text-muted">
          Relevé automatique {frequence(status?.reglages)}. Dernier relevé : {dateTime(status?.dernierPassage)}
          {status?.dernierResultat ? ` (${status.dernierResultat.nouveaux} ajouté(s))` : ""}.
          {status?.dernierResultat && status.dernierResultat.lecturePdf === false ? " Lecture des PDF désactivée : montants à saisir." : ""}
        </p>
      )}
      {connected && !status?.erreur && (
        <p className="text-sm">
          {du && au ? (
            <>« Relever cette période » cherche dans Gmail les mails reçus <strong>du {fr(du)} au {fr(au)}</strong>, y compris ceux écartés avant.</>
          ) : (
            <>« Relever les nouveaux mails » cherche les mails arrivés depuis le dernier relevé. Choisis une période en haut pour chercher plus loin.</>
          )}
        </p>
      )}
      {retour && RETOUR_GMAIL[retour] && <p className="rounded-control bg-info-soft p-3 text-sm">{RETOUR_GMAIL[retour]}</p>}
      {info && <p className="rounded-control bg-success-soft p-3 text-sm">{info}</p>}
      <ErrorBox message={error || status?.erreur || null} />
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        {connected ? (
          <>
            {status?.erreur ? (
              <Button className="col-span-2" disabled={busy !== null} onClick={() => run("connect")}>Reconnecter</Button>
            ) : (
              <>
                <Button disabled={busy !== null} onClick={() => run("sync")}>{busy === "sync" ? "Relevé en cours…" : du && au ? "Relever cette période" : "Relever les nouveaux mails"}</Button>
                <Button variant="secondary" disabled={busy !== null} onClick={() => run("lire")}>{busy === "lire" ? "Lecture en cours…" : "Lire les PDF avec l'IA"}</Button>
              </>
            )}
            <Button variant="ghost" className="col-span-2 sm:order-first" disabled={busy !== null} onClick={() => run("disconnect")}>Déconnecter</Button>
          </>
        ) : (
          <Button className="col-span-2" disabled={busy !== null || !status} onClick={() => run("connect")}>Connecter Gmail</Button>
        )}
      </div>
    </Card>
  );
}

interface Form {
  fournisseur: string;
  numero: string;
  date: string;
  echeance: string;
  ht: string;
  tva: string;
  ttc: string;
  frais: string;
  reference: string;
}

function formOf(item: InboxItem): Form {
  if (item.kind === "facture") {
    return {
      fournisseur: item.fournisseur,
      numero: item.numero ?? "",
      date: item.dateFacture ?? "",
      echeance: item.dateEcheance ?? "",
      ht: euros(item.montantHT),
      tva: euros(item.montantTVA),
      ttc: euros(item.montantTTC),
      frais: "",
      reference: "",
    };
  }
  return { fournisseur: "Uber Eats", numero: "", date: item.date ?? "", echeance: "", ht: "", tva: "", ttc: euros(item.montant), frais: euros(item.frais), reference: item.reference ?? "" };
}

function ReviewSheet({ id, d, mailbox, onClose }: { id: string; d: InboxDoc; mailbox?: string; onClose: () => void }) {
  const { rid } = useRestaurant();
  const [f, setF] = useState<Form>(() => formOf(d.item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function valider() {
    setBusy(true);
    setError(null);
    try {
      const ttc = toCents(f.ttc);
      if (ttc === null) throw new Error("Montant TTC illisible.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) throw new Error("Date manquante.");
      const batch = writeBatch(db());
      const now = new Date().getTime();
      if (d.item.kind === "facture") {
        const nom = f.fournisseur.trim();
        if (!nom) throw new Error("Fournisseur manquant.");
        const ht = f.ht ? toCents(f.ht) : null;
        const tvaIn = f.tva ? toCents(f.tva) : null;
        const tva = tvaIn ?? (ht !== null ? ttc - ht : 0);
        // Fournisseur retrouvé par son nom (sans tenir compte de la casse), sinon créé.
        const all = await getDocs(collection(db(), "restaurants", rid, "suppliers"));
        const found = all.docs.find((s) => String(s.data().nom).toLowerCase() === nom.toLowerCase());
        const supplierRef = found ? found.ref : doc(collection(db(), "restaurants", rid, "suppliers"));
        const fromEmail = d.item.source.from?.match(/<([^>]+)>/)?.[1] ?? d.item.source.from ?? "";
        if (!found) batch.set(supplierRef, { nom, email: fromEmail, createdAt: now });
        const numero = f.numero.trim();
        if (numero) {
          const dup = await getDocs(query(collection(db(), "restaurants", rid, "invoices"), where("numero", "==", numero)));
          if (dup.docs.some((x) => x.data().supplierId === supplierRef.id)) throw new Error(`La facture ${numero} de ${nom} existe déjà.`);
        }
        batch.set(doc(collection(db(), "restaurants", rid, "invoices")), {
          supplierId: supplierRef.id,
          supplierNom: found ? String(found.data().nom) : nom,
          numero,
          dateFacture: f.date,
          mois: f.date.slice(0, 7),
          ...(/^\d{4}-\d{2}-\d{2}$/.test(f.echeance) ? { dateEcheance: f.echeance } : {}),
          montantHT: ht ?? ttc - tva,
          montantTVA: tva,
          montantTTC: ttc,
          statut: "a_payer",
          note: `Reçue par mail${d.item.source.from ? ` de ${d.item.source.from}` : ""}`.slice(0, 300),
          createdAt: now,
        });
      } else {
        const frais = f.frais ? toCents(f.frais) : null;
        batch.set(doc(db(), "restaurants", rid, "uberPayouts", `${f.date}_${ttc}_0`), {
          date: f.date,
          montant: ttc,
          ...(d.item.brut !== undefined ? { brut: d.item.brut } : {}),
          ...(frais !== null ? { frais: Math.abs(frais) } : {}),
          ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
          createdAt: now,
        });
      }
      batch.update(doc(db(), "restaurants", rid, "inbox", id), { statut: "valide", traiteLe: now });
      await batch.commit();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function ignorer() {
    setBusy(true);
    try {
      const batch = writeBatch(db());
      batch.update(doc(db(), "restaurants", rid, "inbox", id), { statut: "rejete", traiteLe: new Date().getTime() });
      await batch.commit();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const { user } = useAuth();
  const [lecture, setLecture] = useState(false);
  async function lireIA() {
    if (!user) return;
    setLecture(true);
    setError(null);
    try {
      const { relu } = await api(user, `/api/gmail/sync?r=${rid}&mode=lire&i=${encodeURIComponent(id)}`);
      if (relu.status !== "ok") setError(relu.message ?? "Lecture impossible.");
      // Le document mis à jour arrive par l'écoute Firestore : la fiche se recharge (clé = relu).
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLecture(false);
    }
  }

  const facture = d.item.kind === "facture";
  const boite = d.item.source.boite;
  const adresseBoite = !boite || boite === rid ? mailbox : restaurant(boite).boiteMail;
  return (
    <Sheet open onClose={onClose} title={facture ? "Facture reçue par mail" : "Versement Uber Eats"}>
      <div className="space-y-3">
        <div className="text-sm text-muted">
          <Boite boite={boite} adresse={adresseBoite} className="mb-1 text-sm" />
          <div className="truncate">{d.item.source.from}</div>
          <div className="truncate">{d.item.source.subject}</div>
          {d.item.source.attachment && <div className="truncate">PDF : {d.item.source.attachment}</div>}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {d.item.source.attachment && <PdfApercu requete={`i=${encodeURIComponent(id)}`} nom={facture ? "la facture" : "le PDF"} />}
            <a className="font-medium text-ink underline" href={gmailLink(d.item.source.messageId, adresseBoite)} target="_blank" rel="noreferrer">
              Ouvrir le mail dans Gmail
            </a>
          </div>
        </div>
        {(d.item.incomplet || d.item.lecture) && (
          <div className="space-y-2 rounded-control bg-warning-soft p-3 text-sm">
            <p>
              {(d.item.lecture && RAISON_LECTURE[d.item.lecture]) || "Lecture automatique incomplète : vérifie et complète avec le PDF."}
              {d.item.lectureErreur ? ` (${d.item.lectureErreur})` : ""}
            </p>
            {d.item.source.attachment && (
              <Button variant="secondary" className="w-full" disabled={lecture} onClick={lireIA}>
                {lecture ? "Lecture en cours…" : "Lire ce PDF avec l'IA"}
              </Button>
            )}
          </div>
        )}
        {facture ? (
          <>
            <Field label="Fournisseur"><Input value={f.fournisseur} onChange={set("fournisseur")} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="N° facture"><Input value={f.numero} onChange={set("numero")} /></Field>
              <Field label="Date"><Input type="date" value={f.date} onChange={set("date")} /></Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="HT"><Input inputMode="decimal" value={f.ht} onChange={set("ht")} /></Field>
              <Field label="TVA"><Input inputMode="decimal" value={f.tva} onChange={set("tva")} /></Field>
              <Field label="TTC"><Input inputMode="decimal" value={f.ttc} onChange={set("ttc")} /></Field>
            </div>
            <Field label="Échéance"><Input type="date" value={f.echeance} onChange={set("echeance")} /></Field>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date du virement"><Input type="date" value={f.date} onChange={set("date")} /></Field>
              <Field label="Montant net"><Input inputMode="decimal" value={f.ttc} onChange={set("ttc")} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Frais Uber"><Input inputMode="decimal" value={f.frais} onChange={set("frais")} /></Field>
              <Field label="Référence"><Input value={f.reference} onChange={set("reference")} /></Field>
            </div>
          </>
        )}
        <ErrorBox message={error} />
        <div className="grid grid-cols-2 gap-2">
          <Button variant="secondary" disabled={busy} onClick={ignorer}>Ignorer</Button>
          <Button disabled={busy} onClick={valider}>Valider</Button>
        </div>
      </div>
    </Sheet>
  );
}

function amountOf(item: InboxItem) {
  const v = item.kind === "facture" ? item.montantTTC : item.montant;
  return v === undefined ? "?" : formatEuros(v);
}

/** Éléments ignorés : on peut les remettre dans « À vérifier » en cas d'erreur. */
function Ignores({ items, mailbox, onTraiter }: { items: (InboxDoc & { id: string })[]; mailbox?: string; onTraiter: (id: string) => void }) {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!items.length) return null;

  async function restaurer(id: string) {
    if (!user) return;
    setBusy(id);
    setError(null);
    try {
      await api(user, `/api/inbox/restaurer?r=${rid}&i=${encodeURIComponent(id)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const tries = [...items].sort((a, b) => (b.traiteLe ?? 0) - (a.traiteLe ?? 0)).slice(0, 50);
  return (
    <details className="group mt-8 border-t border-border pt-3">
      <summary className="mx-auto flex min-h-11 w-fit cursor-pointer list-none items-center rounded-control [&::-webkit-details-marker]:hidden px-3 text-sm text-muted underline underline-offset-4">
        <span className="group-open:hidden">Lignes ignorées ({items.length})</span>
        <span className="hidden group-open:inline">Masquer les lignes ignorées</span>
      </summary>
      <p className="mt-2 text-xs text-muted">Ignorée par erreur ? Remets-la dans la liste, ou traite-la directement.</p>
      <ErrorBox message={error} />
      <ul className="mt-2 space-y-2">
        {tries.map((d) => (
          <li key={d.id}>
            <Card className="space-y-2">
              <div className="min-w-0">
                <div className="truncate font-semibold">{d.item.kind === "facture" ? d.item.fournisseur : "Versement Uber Eats"}</div>
                <div className="truncate text-xs text-muted">
                  Reçu le {fr(jourRecu(d)) || "?"} · {d.item.source.subject}
                </div>
                <div className="text-xs text-muted">{amountOf(d.item)}{d.traiteLe ? ` · ignoré le ${new Date(d.traiteLe).toLocaleDateString("fr-FR")}` : ""}</div>
                <Boite boite={d.item.source.boite} adresse={d.item.source.boite === rid ? mailbox : undefined} className="mt-1" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="secondary" className="text-sm" disabled={busy !== null} onClick={() => restaurer(d.id)}>
                  {busy === d.id ? "…" : "Remettre à vérifier"}
                </Button>
                <Button className="text-sm" disabled={busy !== null} onClick={() => onTraiter(d.id)}>
                  Traiter
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      {items.length > tries.length && <p className="mt-2 text-xs text-muted">Seuls les 50 derniers ignorés sont affichés.</p>}
    </details>
  );
}

/** Éléments reçus par mail (factures fournisseurs, versements Uber) en attente de validation. */
function AVerifier() {
  const { rid } = useRestaurant();
  const inbox = useCollection<InboxDoc>("inbox", "receivedAt", true);
  const [open, setOpen] = useState<string | null>(null);
  const [mailbox, setMailbox] = useState<string | undefined>();
  const [du, setDu] = useState("");
  const [au, setAu] = useState("");
  const enAttente = useMemo(() => inbox.items.filter((i) => i.statut === "a_verifier"), [inbox.items]);
  const todo = useMemo(
    () =>
      enAttente.filter((i) => {
        const j = jourRecu(i);
        return (!du || (j !== "" && j >= du)) && (!au || (j !== "" && j <= au));
      }),
    [enAttente, du, au],
  );
  const jours = todo.map(jourRecu).filter(Boolean).sort();
  const horsPeriode = enAttente.length - todo.length;
  const ignores = useMemo(() => inbox.items.filter((i) => i.statut === "rejete"), [inbox.items]);
  const current = inbox.items.find((i) => i.id === open && (i.statut === "a_verifier" || i.statut === "rejete"));
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => onSnapshot(doc(db(), "restaurants", rid, "settings", "mail"), (s) => setMailbox(s.get("adresse") as string | undefined), () => {}), [rid]);

  return (
    <div>
      <PageHeader title="À vérifier" />
      <PeriodeBar du={du} au={au} onChange={(a, b) => (setDu(a), setAu(b))} />
      <MailCard du={du} au={au} />
      <div className="mb-3 rounded-control bg-info-soft p-3 text-sm">
        <div className="font-semibold">
          {todo.length} élément{todo.length > 1 ? "s" : ""} à vérifier
          {du && au ? ` · mails reçus du ${fr(du)} au ${fr(au)}` : " · toutes les dates"}
        </div>
        {jours.length > 0 && (
          <div className="text-muted">
            Le plus ancien reçu le {fr(jours[0])}, le plus récent le {fr(jours[jours.length - 1])}.
          </div>
        )}
        {horsPeriode > 0 && <div className="text-muted">{horsPeriode} autre(s) en attente hors de cette période.</div>}
      </div>
      <p className="mb-4 text-sm text-muted">Touche un élément pour le vérifier : une fois validé, il passe dans Factures ou Caisse &gt; Uber.</p>
      <ErrorBox message={inbox.error} />
      {inbox.loading ? (
        <p className="text-muted">Chargement…</p>
      ) : todo.length === 0 ? (
        <Empty>{du && au ? "Rien à vérifier sur cette période." : "Rien à vérifier."}</Empty>
      ) : (
        <ul className="space-y-2">
          {todo.map(({ id, ...d }) => (
            <li key={id}>
              <button className="block w-full text-left" onClick={() => setOpen(id)}>
                <Card className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{d.item.kind === "facture" ? d.item.fournisseur : "Versement Uber Eats"}</div>
                    <div className="truncate text-sm text-muted">
                      {d.item.kind === "facture"
                        ? [d.item.numero && `N° ${d.item.numero}`, fr(d.item.dateFacture)].filter(Boolean).join(" · ")
                        : [fr(d.item.date), d.item.reference].filter(Boolean).join(" · ")}
                    </div>
                    <div className="truncate text-xs text-muted">
                      <span className="font-medium text-ink">Reçu le {fr(jourRecu(d as InboxDoc)) || "?"}</span> · {d.item.source.subject}
                    </div>
                    <Boite boite={d.item.source.boite} adresse={d.item.source.boite === rid ? mailbox : undefined} className="mt-1" />
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-semibold tabular-nums">{amountOf(d.item)}</div>
                    <Badge tone={d.item.incomplet ? "red" : "orange"}>{d.item.incomplet ? "À compléter" : "À vérifier"}</Badge>
                  </div>
                </Card>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Ignores items={ignores} mailbox={mailbox} onTraiter={setOpen} />
      {current && <ReviewSheet key={`${current.id}-${current.relu ?? 0}`} id={current.id} d={current} mailbox={mailbox} onClose={close} />}
    </div>
  );
}

export default function AVerifierPage() {
  return (
    <Suspense>
      <AVerifier />
    </Suspense>
  );
}
