import { tool } from "ai";
import { z } from "zod";

const CATALOG_BASE_URL = "https://catalogomotoetrilha.manus.space";

export interface CatalogVehicle {
  id: number;
  modelo: string;
  marca: string;
  ano: number;
  preco: number;
  imageUrl: string;
  tipo?: "moto" | "carro" | "eletrico";
  cor?: string | null;
  quilometragem?: number | null;
  descricao?: string | null;
  status?: string;
}

// Customers type accents ("elétrica") the catalog's own data doesn't consistently
// use ("Eletrica", "ELetrica") — strip diacritics on both sides before comparing.
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Words customers use that don't literally appear in any modelo/marca string —
// "bike"/"scooter" name a category, not a model. "scooter" is deliberately not
// mapped here: this catalog's gas scooters (Nmax, Aerox) are tipo "moto", so a
// bare "scooter" query should fall through to normal matching, not assume electric.
const TYPE_BY_WORD: Record<string, CatalogVehicle["tipo"]> = {
  moto: "moto",
  motos: "moto",
  motocicleta: "moto",
  motocicletas: "moto",
  carro: "carro",
  carros: "carro",
  automovel: "carro",
  automoveis: "carro",
  bicicleta: "eletrico",
  bicicletas: "eletrico",
  bike: "eletrico",
  bikes: "eletrico",
};

export function filterVehicles(vehicles: CatalogVehicle[], query: string): CatalogVehicle[] {
  const q = normalize(query.trim());
  if (!q) return vehicles;

  const impliedTypes = new Set<CatalogVehicle["tipo"]>();
  for (const word of q.split(/\s+/)) {
    if (word.startsWith("eletric")) impliedTypes.add("eletrico");
    const mapped = TYPE_BY_WORD[word];
    if (mapped) impliedTypes.add(mapped);
  }

  return vehicles.filter((v) => {
    if (
      normalize(v.modelo).includes(q) ||
      normalize(v.marca).includes(q) ||
      normalize(v.cor ?? "").includes(q) ||
      normalize(v.descricao ?? "").includes(q)
    ) {
      return true;
    }
    return v.tipo !== undefined && impliedTypes.has(v.tipo);
  });
}

// Exact match first (handles the common case cleanly), then falls back to a
// substring match in either direction — the model may pass back a shortened
// or slightly reworded modelo (e.g. "Happy 500w" for "Bicicleta ELetrica
// Happy 500w"). Looking the vehicle up fresh here (rather than trusting a
// model-supplied imageUrl/preco) is the fix for a real failure: our own
// conversation history only stores the human-readable caption, never the
// raw URL, so on a later turn the model had nothing to recall it from and
// fabricated a plausible-looking but fake URL.
export function findVehicleByModel(vehicles: CatalogVehicle[], modelo: string): CatalogVehicle | undefined {
  const q = normalize(modelo.trim());
  if (!q) return undefined;
  return (
    vehicles.find((v) => normalize(v.modelo) === q) ??
    vehicles.find((v) => normalize(v.modelo).includes(q) || q.includes(normalize(v.modelo)))
  );
}

// Most catalog entries store a relative path ("/manus-storage/..."), but some
// (verified live: ~8 of 27, including both electric bikes) already carry a
// fully-qualified URL from a different host (motos-img.autoflows.com.br,
// supabase storage). Prefixing those with CATALOG_BASE_URL produced a
// corrupted, unfetchable URL — only prefix when the value isn't already absolute.
export function resolveImageUrl(imageUrl: string): string {
  return /^https?:\/\//.test(imageUrl) ? imageUrl : `${CATALOG_BASE_URL}${imageUrl}`;
}

export function formatVehicleList(vehicles: CatalogVehicle[]): string {
  return vehicles
    .slice(0, 5)
    .map((v) => {
      const price = `R$ ${v.preco.toLocaleString("pt-BR")}`;
      const imageUrl = resolveImageUrl(v.imageUrl);
      const details = [v.cor, v.ano].filter(Boolean).join(", ");
      const km = v.quilometragem !== undefined && v.quilometragem !== null
        ? `${v.quilometragem.toLocaleString("pt-BR")} km`
        : null;
      const extras = [details, km].filter(Boolean).join(", ");
      const description = v.descricao ? ` — ${v.descricao}` : "";
      return `- ${v.modelo} (${v.marca}${extras ? `, ${extras}` : ""}) — ${price}${description} — foto: ${imageUrl}`;
    })
    .join("\n");
}

export function buildCatalogSearchResult(vehicles: CatalogVehicle[], query: string): string {
  const matches = filterVehicles(vehicles, query);
  if (matches.length > 0) {
    return formatVehicleList(matches);
  }
  const fallback = vehicles.slice(0, 5);
  return `Nenhum veículo encontrado para "${query}". Aqui estão outras opções disponíveis no catálogo — se alguma for parecida com o que o cliente quer, sugira antes de dizer que não há disponibilidade:\n${formatVehicleList(fallback)}`;
}

export async function fetchCatalog(): Promise<CatalogVehicle[]> {
  const input = encodeURIComponent(JSON.stringify({ "0": { json: { search: "" } } }));
  const response = await fetch(`${CATALOG_BASE_URL}/api/trpc/vehicles.list?batch=1&input=${input}`);
  if (!response.ok) {
    throw new Error(`Catalog API error ${response.status}`);
  }
  const data = await response.json();
  const vehicles = data[0].result.data.json as CatalogVehicle[];
  return vehicles.filter((v) => v.status === undefined || v.status === "available");
}

export function createSearchCatalogTool() {
  return tool({
    description:
      "Search the full vehicle catalog by brand, model, color, or description. Returns matching vehicles with price, color, mileage, description and photo URL, or suggestions from the catalog if nothing matches exactly.",
    inputSchema: z.object({
      query: z.string().describe("Brand, model, color, or keyword to search for, e.g. 'Bros 160', 'Honda', or 'branca'"),
    }),
    execute: async ({ query }) => {
      const vehicles = await fetchCatalog();
      return buildCatalogSearchResult(vehicles, query);
    },
  });
}
