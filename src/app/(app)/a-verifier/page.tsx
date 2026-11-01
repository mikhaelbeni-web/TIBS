"use client";

import { collection, doc, getDocs, onSnapshot, query, where, writeBatch } from "firebase/firestore";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Sheet } from "@/components/ui";
import { useRestaurant } from "@/components/RestaurantProvider";
import { isRestaurantId } from "@/lib/restaurants";
import { db } from "@/lib/firebase";
import type { InboxDoc, InboxItem } from "@/lib/ingest";
import { formatEuros, toCents } from "@/lib/money";
import { useCollection } from "@/lib/useCollection";

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
const euros = (c?: number) => (c === undefined ? "" : (c / 100).toFixed(2).replace(".", ","));
const gmailLink = (id: string, mailbox?: string) =>
  `https://mail.google.com/mail/${mailbox ? `?authuser=${encodeURIComponent(mailbox)}` : ""}#all/${id}`;

interface MailStatus {
  adresse?: string;
  connecteLe?: number;
  dernierPassage?: number;
  dernierEssai?: number;
  erreur?: string;
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

/** Carte « Boîte mail » : connexion Gmail, dernier relevé, bouton pour relever tout de suite. */
function MailCard() {
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
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => onSnapshot(doc(db(), "restaurants", rid, "settings", "mail"), (s) => setStatus((s.data() as MailStatus) ?? {}), (e) => setError(e.message)), [rid]);

  async function run(kind: "connect" | "sync" | "disconnect") {
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
      if (kind === "disconnect" && !confirm("Déconnecter la boîte mail ? Les relevés automatiques s'arrêtent.")) return;
      const r = await api(user, `/api/gmail/${kind === "sync" ? "sync" : "disconnect"}?r=${rid}`);
      if (kind === "sync") {
        setInfo(
          r.status === "ok"
            ? `${r.messagesVus} mail(s) lu(s), ${r.nouveaux} élément(s) ajouté(s).${r.incomplet ? " Il en reste : relance pour continuer." : ""}`
            : r.message,
        );
        if (r.relu?.status === "ok" && r.relu.relus) {
          setInfo((i) => `${i ?? ""} PDF relus : ${r.relu.relus}, dont ${r.relu.completes} complété(s).${r.relu.restants ? ` Encore ${r.relu.restants} à compléter.` : ""}`.trim());
        }
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
          Relevé automatique chaque matin. Dernier relevé : {dateTime(status?.dernierPassage)}
          {status?.dernierResultat ? ` (${status.dernierResultat.nouveaux} ajouté(s))` : ""}.
          {status?.dernierResultat && status.dernierResultat.lecturePdf === false ? " Lecture des PDF désactivée : montants à saisir." : ""}
        </p>
      )}
      {retour && RETOUR_GMAIL[retour] && <p className="rounded-control bg-info-soft p-3 text-sm">{RETOUR_GMAIL[retour]}</p>}
      {info && <p className="rounded-control bg-success-soft p-3 text-sm">{info}</p>}
      <ErrorBox message={error || status?.erreur || null} />
      <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
        {connected ? (
          <>
            <Button variant="ghost" disabled={busy !== null} onClick={() => run("disconnect")}>Déconnecter</Button>
            {status?.erreur ? (
              <Button disabled={busy !== null} onClick={() => run("connect")}>Reconnecter</Button>
            ) : (
              <Button disabled={busy !== null} onClick={() => run("sync")}>{busy === "sync" ? "Relevé en cours…" : "Vérifier maintenant"}</Button>
            )}
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

/** Aperçu du PDF joint, récupéré à la demande depuis Gmail (rien n'est stocké). */
function PdfApercu({ id, nom }: { id: string; nom: string }) {
  const { rid } = useRestaurant();
  const { user } = useAuth();
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  async function voir() {
    if (open) return setOpen(false);
    setOpen(true);
    if (url || !user) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/gmail/pdf?r=${rid}&i=${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await user.getIdToken()}` },
      });
      if (!res.ok) {
        const text = await res.text();
        let msg = `Erreur ${res.status}`;
        try {
          msg = JSON.parse(text).error || msg;
        } catch {}
        throw new Error(msg);
      }
      setUrl(URL.createObjectURL(await res.blob()));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" onClick={voir} className="font-medium text-ink underline">
        {open ? `Masquer ${nom}` : `Voir ${nom}`}
      </button>
      {open && (
        <div className="order-last mt-2 basis-full space-y-2">
          {busy && <p className="text-sm text-muted">Chargement du PDF…</p>}
          <ErrorBox message={error} />
          {url && (
            <>
              <iframe src={url} title="Facture PDF" className="h-[60dvh] w-full rounded-control border border-border bg-white" />
              <a href={url} target="_blank" rel="noreferrer" className="inline-block text-sm font-medium text-ink underline">
                Ouvrir en plein écran
              </a>
            </>
          )}
        </div>
      )}
    </>
  );
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

  const facture = d.item.kind === "facture";
  return (
    <Sheet open onClose={onClose} title={facture ? "Facture reçue par mail" : "Versement Uber Eats"}>
      <div className="space-y-3">
        <div className="text-sm text-muted">
          <div className="truncate">{d.item.source.from}</div>
          <div className="truncate">{d.item.source.subject}</div>
          {d.item.source.attachment && <div className="truncate">PDF : {d.item.source.attachment}</div>}
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
            {d.item.source.attachment && <PdfApercu id={id} nom={facture ? "la facture" : "le PDF"} />}
            <a className="font-medium text-ink underline" href={gmailLink(d.item.source.messageId, mailbox)} target="_blank" rel="noreferrer">
              Ouvrir le mail dans Gmail
            </a>
          </div>
        </div>
        {d.item.incomplet && <p className="rounded-control bg-warning-soft p-3 text-sm">Lecture automatique incomplète : vérifie et complète avec le PDF.</p>}
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

/** Éléments reçus par mail (factures fournisseurs, versements Uber) en attente de validation. */
function AVerifier() {
  const { rid } = useRestaurant();
  const inbox = useCollection<InboxDoc>("inbox", "receivedAt", true);
  const [open, setOpen] = useState<string | null>(null);
  const [mailbox, setMailbox] = useState<string | undefined>();
  const todo = useMemo(() => inbox.items.filter((i) => i.statut === "a_verifier"), [inbox.items]);
  const current = todo.find((i) => i.id === open);
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => onSnapshot(doc(db(), "restaurants", rid, "settings", "mail"), (s) => setMailbox(s.get("adresse") as string | undefined), () => {}), [rid]);

  return (
    <div>
      <PageHeader title="À vérifier" />
      <MailCard />
      <p className="mb-4 text-sm text-muted">
        Factures et versements Uber trouvés dans les mails. Touche un élément pour le vérifier : une fois validé, il passe dans Factures ou Caisse &gt; Uber.
      </p>
      <ErrorBox message={inbox.error} />
      {inbox.loading ? (
        <p className="text-muted">Chargement…</p>
      ) : todo.length === 0 ? (
        <Empty>Rien à vérifier.</Empty>
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
                    <div className="truncate text-xs text-muted">{d.item.source.subject}</div>
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
      {current && <ReviewSheet key={current.id} id={current.id} d={current} mailbox={mailbox} onClose={close} />}
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
