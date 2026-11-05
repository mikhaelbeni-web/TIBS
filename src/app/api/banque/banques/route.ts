import { trierBanques } from "@/lib/banque";
import { requireGerant } from "@/lib/server/authz";
import { banques, configuree } from "@/lib/server/enableBanking";

/** GET /api/banque/banques (gérant) → { configuree, banques: [{ name, psuTypes }] } : banques françaises disponibles. */
export async function GET(request: Request) {
  const uid = await requireGerant(request);
  if (uid instanceof Response) return uid;
  if (!configuree()) return Response.json({ configuree: false, banques: [] });
  try {
    const liste = trierBanques(await banques()).map((b) => ({ name: b.name, psuTypes: b.psu_types ?? [] }));
    return Response.json({ configuree: true, banques: liste });
  } catch (e) {
    return Response.json({ configuree: true, error: (e as Error).message }, { status: 502 });
  }
}
