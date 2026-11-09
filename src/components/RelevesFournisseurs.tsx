"use client";

import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { PdfApercu } from "@/components/PdfApercu";
import { useRestaurant } from "@/components/RestaurantProvider";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, Sheet } from "@/components/ui";
import { emailOf } from "@/lib/mail";
import { formatEuros } from "@/lib/money";
import { brouillonReclamation, derniereReclamation, emailValide, facturesPourReleve, lignesAReclamer, nomCle, periodeReleve } from "@/lib/reclamation";
import { normNumero, rapprocher, type Releve, type ReleveLigne } from "@/lib/releves";
import { isRestaurantId, restaurant, type RestaurantId } from "@/lib/restaurants";
import type { Invoice, Supplier, WithId } from "@/lib/types";

const fr = (iso?: string) => (iso ? iso.split("-").reverse().join("/") : "");
const frJour = (ms: number) => new Date(ms).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });

type EtatManquante = "a_reclamer" | "reclamee" | "dans_boite";

interface Manquante {
  ligne: ReleveLigne;
  etat: EtatManquante;
  detail?: string;
}

interface ReleveCalcule {
  releve: WithId<Releve>;
  manquantes: Manquante[];
  recues: number;
  date: string;
}

/** État d'une ligne non reçue : trouvée dans une boîte (pas à réclamer), déjà réclamée, ou à réclamer. */
function etatLigne(r: Releve, l: ReleveLigne): Manquante {
  const t = r.verif?.trouvees[normNumero(l.numero)];
  if (t) return { ligne: l, etat: "dans_boite", detail: `Dans la boîte ${restaurant(isRestaurantId(t.boite) ? t.boite : "19e").court}${t.date ? ` (mail du ${fr(t.date)})` : ""} : pas encore relevée` };
  const rec = derniereReclamation(r, l.numero);
  if (rec) return { ligne: l, etat: "reclamee", detail: `Réclamée le ${frJour(rec.le)} à ${rec.a}` };
  return { ligne: l, etat: "a_reclamer" };
}

/**
 * Onglet « Relevés » de Factures : tous les fournisseurs qui envoient un relevé / récapitulatif de factures,
 * et pour chacun les factures listées qu'on n'a jamais reçues, avec le bouton pour les réclamer par mail.
 */
export function RelevesFournisseurs({
  releves,
  factures,
  enAttente,
  suppliers,
}: {
  releves: WithId<Releve>[];
  factures: WithId<Invoice>[];
  enAttente: string[];
  suppliers: WithId<Supplier>[];
}) {
  const [ouvert, setOuvert] = useState<{ r: ReleveCalcule; mode: Supplier["paiement"] } | null>(null);

  const groupes = useMemo(() => {
    const calc: ReleveCalcule[] = releves
      .filter((r) => r.lignes.length > 0)
      .map((releve) => {
        const rp = rapprocher(releve, facturesPourReleve(releve, factures), enAttente);
        return {
          releve,
          manquantes: lignesAReclamer(rp, releve.justifies).map((l) => etatLigne(releve, l)),
          recues: rp.lignes.filter((l) => l.etat !== "non_recue").length,
          date: (releve.source.receivedAt ?? releve.dateReleve ?? `${releve.mois}-01`).slice(0, 10),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    const parFournisseur = new Map<string, { nom: string; supplier?: WithId<Supplier>; releves: ReleveCalcule[] }>();
    for (const c of calc) {
      const k = c.releve.supplierId ?? nomCle(c.releve.fournisseur);
      const supplier = suppliers.find((s) => s.id === c.releve.supplierId) ?? suppliers.find((s) => nomCle(s.nom) === nomCle(c.releve.fournisseur));
      const g = parFournisseur.get(supplier?.id ?? k) ?? { nom: supplier?.nom ?? c.releve.fournisseur, supplier, releves: [] };
      g.releves.push(c);
      parFournisseur.set(supplier?.id ?? k, g);
    }
    const aReclamer = (g: { releves: ReleveCalcule[] }) => g.releves.reduce((t, r) => t + r.manquantes.filter((m) => m.etat === "a_reclamer").length, 0);
    return [...parFournisseur.values()].sort((a, b) => aReclamer(b) - aReclamer(a) || a.nom.localeCompare(b.nom));
  }, [releves, factures, enAttente, suppliers]);

  const total = groupes.flatMap((g) => g.releves.flatMap((r) => r.manquantes));
  const nbAReclamer = total.filter((m) => m.etat === "a_reclamer").length;
  const nbReclamees = total.filter((m) => m.etat === "reclamee").length;
  const nbBoite = total.filter((m) => m.etat === "dans_boite").length;

  if (!groupes.length) {
    return <Empty>Aucun relevé fournisseur pour l&apos;instant. Ils sont repérés chaque jour dans les mails.</Empty>;
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-1 text-sm">
        <p>
          <strong>{groupes.length}</strong> fournisseur{groupes.length > 1 ? "s envoient" : " envoie"} un relevé de factures. Chaque ligne est comparée aux
          factures reçues, et cherchée dans les deux boîtes mail.
        </p>
        <p>
          {nbAReclamer ? <strong className="text-danger">{nbAReclamer} facture{nbAReclamer > 1 ? "s" : ""} à réclamer</strong> : "Aucune facture à réclamer"}
          {nbReclamees ? ` · ${nbReclamees} déjà réclamée${nbReclamees > 1 ? "s" : ""}` : ""}
          {nbBoite ? ` · ${nbBoite} dans la boîte mail, pas encore relevée${nbBoite > 1 ? "s" : ""}` : ""}.
        </p>
      </Card>

      <ul className="space-y-3">
        {groupes.map((g) => {
          const n = g.releves.reduce((t, r) => t + r.manquantes.filter((m) => m.etat === "a_reclamer").length, 0);
          return (
            <li key={g.nom}>
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="min-w-0 truncate font-semibold">{g.nom}</h3>
                  {n ? <Badge tone="red">{n} à réclamer</Badge> : <Badge tone="green">Rien à réclamer</Badge>}
                </div>
                <ul className="space-y-2">
                  {g.releves.slice(0, 6).map((c) => (
                    <ReleveLigneCarte key={c.releve.id} c={c} onReclamer={() => setOuvert({ r: c, mode: g.supplier?.paiement ?? "virement" })} />
                  ))}
                </ul>
                {g.releves.length > 6 && <p className="text-xs text-muted">Et {g.releves.length - 6} relevé(s) plus ancien(s).</p>}
              </Card>
            </li>
          );
        })}
      </ul>

      {ouvert && <ReclamationSheet c={ouvert.r} mode={ouvert.mode} onClose={() => setOuvert(null)} />}
    </div>
  );
}

function ReleveLigneCarte({ c, onReclamer }: { c: ReleveCalcule; onReclamer: () => void }) {
  const r = c.releve;
  const aReclamer = c.manquantes.filter((m) => m.etat !== "dans_boite");
  return (
    <li>
      <details className="rounded-control border border-border p-3 text-sm" open={c.manquantes.some((m) => m.etat === "a_reclamer")}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
          <span className="min-w-0">
            <span className="font-medium">Relevé{r.numero ? ` n° ${r.numero}` : ""}</span>
            <span className="text-muted"> {periodeReleve(r)} · reçu le {fr(c.date)}</span>
          </span>
          <span className="text-xs text-muted tabular-nums">
            {c.recues}/{r.lignes.length} reçues
          </span>
        </summary>
        <div className="mt-3 space-y-3">
          {!r.coherent && <p className="rounded-control bg-warning-soft p-2 text-xs">Lecture du relevé à vérifier (total différent de la somme des lignes) : relis le PDF avant de réclamer.</p>}
          {c.manquantes.length === 0 ? (
            <p className="text-muted">Toutes les factures du relevé sont reçues.</p>
          ) : (
            <ul className="divide-y divide-border">
              {c.manquantes.map((m) => (
                <li key={m.ligne.numero} className="flex items-start justify-between gap-2 py-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">
                      N° {m.ligne.numero}
                      {m.ligne.date ? <span className="font-normal text-muted"> du {fr(m.ligne.date)}</span> : null}
                    </div>
                    <div className="text-xs text-muted">{m.detail ?? "Jamais reçue : à réclamer au fournisseur"}</div>
                  </div>
                  <span className="shrink-0 tabular-nums">{formatEuros(m.ligne.montantTTC)}</span>
                </li>
              ))}
            </ul>
          )}
          {aReclamer.length > 0 && (
            <Button className="w-full sm:w-auto" onClick={onReclamer}>
              {c.manquantes.some((m) => m.etat === "a_reclamer") ? "Réclamer" : "Relancer"} {aReclamer.length > 1 ? `les ${aReclamer.length} factures` : "la facture"}
            </Button>
          )}
          {r.source.attachment && <PdfApercu requete={`c=releve&i=${encodeURIComponent(r.id)}`} nom="le relevé" />}
        </div>
      </details>
    </li>
  );
}

type Etape =
  | { e: "verification" }
  | { e: "brouillon"; lignes: ReleveLigne[]; dansBoite: Manquante[] }
  | { e: "rien"; dansBoite: Manquante[] }
  | { e: "autoriser"; boite: RestaurantId; message: string }
  | { e: "envoye"; a: string; de: string };

/** Aperçu du mail de réclamation, modifiable ; rien ne part sans le clic sur « Envoyer ». */
function ReclamationSheet({ c, mode, onClose }: { c: ReleveCalcule; mode: Supplier["paiement"]; onClose: () => void }) {
  const { user } = useAuth();
  const { rid } = useRestaurant();
  const r = c.releve;
  const boite: RestaurantId = isRestaurantId(r.source.boite) ? r.source.boite : rid;
  const [etape, setEtape] = useState<Etape>({ e: "verification" });
  const [a, setA] = useState(emailOf(r.source.from ?? ""));
  const [objet, setObjet] = useState("");
  const [corps, setCorps] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);

  const appel = async (chemin: string, body: unknown) => {
    const res = await fetch(`${chemin}?r=${rid}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${await user!.getIdToken()}` },
      body: JSON.stringify(body),
    });
    return { res, b: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  // Avant de rédiger : on vérifie dans les deux boîtes que ces factures n'y sont vraiment pas.
  useEffect(() => {
    if (!user) return;
    let fini = false;
    const candidates = c.manquantes.filter((m) => m.etat !== "dans_boite");
    appel("/api/releves/verifier", { releveId: r.id, numeros: candidates.map((m) => m.ligne.numero) })
      .then(({ res, b }) => {
        if (fini) return;
        if (!res.ok) throw new Error(String(b.error ?? `Erreur ${res.status}`));
        const trouvees = (b.trouvees ?? {}) as Record<string, { boite: string; date?: string }>;
        const dansBoite = [
          ...c.manquantes.filter((m) => m.etat === "dans_boite"),
          ...candidates
            .filter((m) => trouvees[normNumero(m.ligne.numero)])
            .map((m) => ({ ...m, etat: "dans_boite" as const, detail: `Trouvée dans un mail du ${fr(trouvees[normNumero(m.ligne.numero)].date)} : pas encore relevée` })),
        ];
        const lignes = candidates.filter((m) => !trouvees[normNumero(m.ligne.numero)]).map((m) => m.ligne);
        if (!lignes.length) return setEtape({ e: "rien", dansBoite });
        const resto = restaurant(boite);
        const d = brouillonReclamation(r, lignes, { nom: resto.nom, adresse: resto.adresse, societe: resto.societe }, mode);
        setObjet(d.objet);
        setCorps(d.corps);
        setEtape({ e: "brouillon", lignes, dansBoite });
      })
      .catch((e) => setErreur((e as Error).message));
    return () => {
      fini = true;
    };
    // Une seule vérification à l'ouverture de l'aperçu.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function envoyer() {
    if (etape.e !== "brouillon" || !user) return;
    setErreur(null);
    setEnvoi(true);
    try {
      const { res, b } = await appel("/api/releves/reclamer", { releveId: r.id, a: a.trim(), objet, corps, numeros: etape.lignes.map((l) => l.numero) });
      if (res.status === 409 && b.code === "envoi") {
        setEtape({ e: "autoriser", boite: isRestaurantId(b.boite) ? b.boite : boite, message: String(b.error ?? "") });
        return;
      }
      if (!res.ok) throw new Error(String(b.error ?? `Erreur ${res.status}`));
      setEtape({ e: "envoye", a: a.trim(), de: String(b.de ?? "") });
    } catch (e) {
      setErreur((e as Error).message);
    } finally {
      setEnvoi(false);
    }
  }

  async function autoriser(b: RestaurantId) {
    if (!user) return;
    setErreur(null);
    try {
      const res = await fetch(`/api/gmail/connect?r=${b}&envoi=1&retour=${encodeURIComponent("/factures?vue=releves")}`, {
        method: "POST",
        headers: { authorization: `Bearer ${await user.getIdToken()}` },
      });
      const j = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !j.url) throw new Error(j.error ?? `Erreur ${res.status}`);
      window.location.href = j.url;
    } catch (e) {
      setErreur((e as Error).message);
    }
  }

  const listeBoite = (dansBoite: Manquante[]) =>
    dansBoite.length > 0 && (
      <div className="rounded-control bg-surface-2 p-2 text-xs">
        <p className="font-medium">Pas réclamée{dansBoite.length > 1 ? "s" : ""}, déjà dans la boîte mail :</p>
        <ul className="mt-1 list-disc pl-4">
          {dansBoite.map((m) => (
            <li key={m.ligne.numero}>
              N° {m.ligne.numero} ({formatEuros(m.ligne.montantTTC)}) : {m.detail}
            </li>
          ))}
        </ul>
        <p className="mt-1">Relève la période dans « À vérifier » pour les ajouter.</p>
      </div>
    );

  return (
    <Sheet open onClose={onClose} title={`Réclamer à ${r.fournisseur}`} large>
      <div className="space-y-3 text-sm">
        <ErrorBox message={erreur} />
        {etape.e === "verification" && !erreur && <p className="text-muted">Recherche de ces factures dans les boîtes mail…</p>}
        {etape.e === "rien" && (
          <>
            <p>Rien à réclamer : toutes ces factures sont déjà arrivées par mail.</p>
            {listeBoite(etape.dansBoite)}
            <Button variant="secondary" className="w-full" onClick={onClose}>Fermer</Button>
          </>
        )}
        {etape.e === "brouillon" && (
          <>
            <p className="text-muted">
              Envoyé depuis <strong>{restaurant(boite).boiteMail}</strong>, en réponse au mail du relevé. Tu peux modifier le texte avant d&apos;envoyer.
            </p>
            <Field label="À">
              <Input type="email" inputMode="email" autoComplete="off" value={a} onChange={(e) => setA(e.target.value)} />
            </Field>
            <Field label="Objet">
              <Input value={objet} onChange={(e) => setObjet(e.target.value)} />
            </Field>
            <Field label="Message">
              <textarea
                value={corps}
                onChange={(e) => setCorps(e.target.value)}
                rows={14}
                className="w-full min-w-0 rounded-control border border-border bg-surface p-3 text-base outline-none focus:border-ink focus:ring-2 focus:ring-primary/60"
              />
            </Field>
            {listeBoite(etape.dansBoite)}
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button className="w-full sm:w-auto" disabled={envoi || !emailValide(a) || !objet.trim() || !corps.trim()} onClick={envoyer}>
                {envoi ? "Envoi…" : "Envoyer le mail"}
              </Button>
              <Button variant="secondary" className="w-full sm:w-auto" onClick={onClose}>Annuler</Button>
            </div>
            {!emailValide(a) && <p className="text-xs text-danger">Adresse du fournisseur invalide.</p>}
          </>
        )}
        {etape.e === "autoriser" && (
          <>
            <p>
              La boîte <strong>{restaurant(etape.boite).boiteMail}</strong> n&apos;autorise pas encore l&apos;app à envoyer des mails. Autorise-le une fois chez Google
              (droit d&apos;envoi seulement), puis reviens réclamer : le mail ne partira toujours que sur ton clic.
            </p>
            <Button className="w-full" onClick={() => autoriser(etape.boite)}>Autoriser l&apos;envoi depuis cette boîte</Button>
          </>
        )}
        {etape.e === "envoye" && (
          <>
            <p className="rounded-control bg-success-soft p-3">
              Mail envoyé à <strong>{etape.a}</strong>
              {etape.de ? ` depuis ${etape.de}` : ""}. Il est dans les « Messages envoyés » de la boîte.
            </p>
            <Button className="w-full" onClick={onClose}>Fermer</Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
