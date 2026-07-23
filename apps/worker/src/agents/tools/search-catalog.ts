import { tool } from "ai";
import { z } from "zod";

const CATALOG_BASE_URL = "https://catalogomotoetrilha.manus.space";

interface CatalogVehicle {
  id: number;
  modelo: string;
  marca: string;
  ano: number;
  preco: number;
  imageUrl: string;
  tipo?: "moto" | "carro" | "eletrico";
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
    if (normalize(v.modelo).includes(q) || normalize(v.marca).includes(q)) return true;
    return v.tipo !== undefined && impliedTypes.has(v.tipo);
  });
}

export function formatVehicleList(vehicles: CatalogVehicle[]): string {
  return vehicles
    .slice(0, 5)
    .map((v) => {
      const price = `R$ ${v.preco.toLocaleString("pt-BR")}`;
      const imageUrl = `${CATALOG_BASE_URL}${v.imageUrl}`;
      return `- ${v.modelo} (${v.marca}, ${v.ano}) — ${price} — foto: ${imageUrl}`;
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

async function fetchCatalog(): Promise<CatalogVehicle[]> {
  const input = encodeURIComponent(JSON.stringify({ "0": { json: { search: "" } } }));
  const response = await fetch(`${CATALOG_BASE_URL}/api/trpc/vehicles.list?batch=1&input=${input}`);
  if (!response.ok) {
    throw new Error(`Catalog API error ${response.status}`);
  }
  const data = await response.json();
  return data[0].result.data.json as CatalogVehicle[];
}

export function createSearchCatalogTool() {
  return tool({
    description:
      "Search the vehicle catalog by brand or model name. Returns matching vehicles with price and photo URL, or suggestions from the catalog if nothing matches exactly.",
    inputSchema: z.object({
      query: z.string().describe("Brand or model name to search for, e.g. 'Bros 160' or 'Honda'"),
    }),
    execute: async ({ query }) => {
      const vehicles = await fetchCatalog();
      return buildCatalogSearchResult(vehicles, query);
    },
  });
}
