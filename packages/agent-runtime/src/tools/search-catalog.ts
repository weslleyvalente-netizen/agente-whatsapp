import { tool, type Tool } from "ai";
import { z } from "zod";

// The catalog moved from a manus.space tRPC backend to its own Supabase
// project behind catalogo.motoetrilha.com.br. This is the same anon key the
// site's own frontend embeds in its JS bundle — public by Supabase's design,
// scoped by RLS, not a secret.
const CATALOG_SUPABASE_URL = "https://orpyesziyiknpebsnhvp.supabase.co";
const CATALOG_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ycHllc3ppeWlrbnBlYnNuaHZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY1NjE4MzAsImV4cCI6MjEwMjEzNzgzMH0.PtubhSu11y3ez8anj3MX19sY3sHEjmnJMkj59vTy84k";
// Used only to make a relative image path absolute — the Supabase API above
// always returns fully-qualified storage URLs, but resolveImageUrl() stays
// generic in case that ever changes.
const CATALOG_BASE_URL = "https://catalogo.motoetrilha.com.br";

export interface CatalogVehicle {
  id: number;
  modelo: string;
  marca: string;
  ano: number;
  preco: number;
  imageUrl: string | null;
  extraImages?: { url: string }[] | null;
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

// Every query word must appear somewhere in the vehicle's searchable text,
// but not necessarily in the same field or order the catalog wrote them in —
// customers naturally mix brand and model ("Honda Bros") or reorder words
// ("fan 160" for a catalog entry named "CG 160 - FAN - Basico"), and neither
// a single-field nor an ordered substring check catches those.
function matchesAllWords(text: string, words: string[]): boolean {
  const normalizedText = normalize(text);
  return words.every((word) => normalizedText.includes(word));
}

function searchableText(v: CatalogVehicle): string {
  return [v.modelo, v.marca, v.cor, v.descricao].filter(Boolean).join(" ");
}

export function filterVehicles(vehicles: CatalogVehicle[], query: string): CatalogVehicle[] {
  const q = normalize(query.trim());
  if (!q) return vehicles;

  const words = q.split(/\s+/);

  const impliedTypes = new Set<CatalogVehicle["tipo"]>();
  for (const word of words) {
    if (word.startsWith("eletric")) impliedTypes.add("eletrico");
    const mapped = TYPE_BY_WORD[word];
    if (mapped) impliedTypes.add(mapped);
  }

  return vehicles.filter((v) => {
    if (matchesAllWords(searchableText(v), words)) {
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

// The catalog sometimes leaves a vehicle's main imageUrl null (e.g. a
// just-added listing) while still carrying real photos in extraImages.
// Feeding that null straight into resolveImageUrl produced a broken link
// like ".../manus.spacenull" that WhatsApp/Evolution silently failed to
// deliver — the tool still reported success. Falling back to the first
// extraImages entry, and returning null only when there's truly no photo,
// lets callers tell the truth instead of sending a dead link.
export function getVehicleImageUrl(vehicle: CatalogVehicle): string | null {
  const raw = vehicle.imageUrl || vehicle.extraImages?.[0]?.url;
  return raw ? resolveImageUrl(raw) : null;
}

export function formatVehicleList(vehicles: CatalogVehicle[]): string {
  return vehicles
    .slice(0, 5)
    .map((v) => {
      const price = `R$ ${v.preco.toLocaleString("pt-BR")}`;
      const imageUrl = getVehicleImageUrl(v) ?? "sem foto disponível";
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

// How many of the query's words appear in this vehicle's searchable text.
// Used only to rank the "nothing matched" fallback — a customer's wording
// (often an official marketing name like "XTZ 250 Lander ABS Connected")
// can include words the dealer's own inventory entry never used ("XTZ",
// "Connected"), which fails the strict AND-match in filterVehicles even
// though the bike itself ("LANDER 250 ABS") is in stock with a photo.
function wordOverlapCount(v: CatalogVehicle, words: string[]): number {
  const normalizedText = normalize(searchableText(v));
  return words.filter((word) => normalizedText.includes(word)).length;
}

export function buildCatalogSearchResult(vehicles: CatalogVehicle[], query: string): string {
  const matches = filterVehicles(vehicles, query);
  if (matches.length > 0) {
    return formatVehicleList(matches);
  }
  const words = normalize(query.trim()).split(/\s+/).filter(Boolean);
  const fallback = [...vehicles]
    .sort((a, b) => wordOverlapCount(b, words) - wordOverlapCount(a, words))
    .slice(0, 5);
  return `Nenhum veículo encontrado para "${query}". Aqui estão outras opções disponíveis no catálogo — se alguma for parecida com o que o cliente quer, sugira antes de dizer que não há disponibilidade:\n${formatVehicleList(fallback)}`;
}

interface CatalogVehicleRow {
  id: number;
  modelo: string;
  marca: string;
  ano: number;
  preco: number;
  quilometragem: number | null;
  cor: string | null;
  descricao: string | null;
  tipo?: CatalogVehicle["tipo"];
  status?: string;
  image_url: string | null;
  vehicle_images?: { url: string }[] | null;
}

export async function fetchCatalog(): Promise<CatalogVehicle[]> {
  const response = await fetch(`${CATALOG_SUPABASE_URL}/rest/v1/vehicles?select=*,vehicle_images(*)&status=eq.available&order=created_at.desc`, {
    headers: {
      apikey: CATALOG_SUPABASE_ANON_KEY,
      Authorization: `Bearer ${CATALOG_SUPABASE_ANON_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Catalog API error ${response.status}`);
  }
  const rows = (await response.json()) as CatalogVehicleRow[];
  return rows
    .map((row) => ({
      id: row.id,
      modelo: row.modelo,
      marca: row.marca,
      ano: row.ano,
      preco: row.preco,
      imageUrl: row.image_url,
      extraImages: row.vehicle_images,
      tipo: row.tipo,
      cor: row.cor,
      quilometragem: row.quilometragem,
      descricao: row.descricao,
      status: row.status,
    }))
    .filter((v) => v.status === undefined || v.status === "available");
}

export function createSearchCatalogTool(): Tool {
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
