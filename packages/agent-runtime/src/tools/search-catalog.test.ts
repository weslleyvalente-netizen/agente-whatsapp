import { describe, it, expect, vi, afterEach } from "vitest";
import { filterVehicles, formatVehicleList, buildCatalogSearchResult, findVehicleByModel, getVehicleImageUrl, fetchCatalog } from "./search-catalog.js";

const vehicles = [
  { id: 1, modelo: "BROS 160 ESDD ABS", marca: "HONDA", ano: 2026, preco: 28900, imageUrl: "/manus-storage/vehicles/bros.png", tipo: "moto" as const },
  { id: 2, modelo: "YZF R15 - 155 ABS Gas", marca: "YAMAHA", ano: 2026, preco: 28900, imageUrl: "/manus-storage/vehicles/r15.png", tipo: "moto" as const },
  { id: 3, modelo: "AVELLOZ AZ1 50CC", marca: "AVELLOZ", ano: 2026, preco: 13900, imageUrl: "/manus-storage/vehicles/az1.png", tipo: "moto" as const },
  { id: 4, modelo: "Bicicleta Eletrica 350w", marca: "ELÉTRICA", ano: 2026, preco: 4900, imageUrl: "/manus-storage/vehicles/bike.png", tipo: "eletrico" as const },
  {
    id: 5,
    modelo: "CELTA LT",
    marca: "CHEVROLET",
    ano: 2013,
    preco: 32900,
    imageUrl: "/manus-storage/vehicles/celta.png",
    tipo: "carro" as const,
    cor: "BRANCO",
    quilometragem: 180000,
    descricao: "Completo, com ar condicionado, direção hidráulica",
  },
];

describe("filterVehicles", () => {
  it("matches by model name, case-insensitive", () => {
    expect(filterVehicles(vehicles, "bros 160")).toEqual([vehicles[0]]);
  });

  it("matches by brand name", () => {
    expect(filterVehicles(vehicles, "yamaha")).toEqual([vehicles[1]]);
  });

  it("returns everything for an empty query", () => {
    expect(filterVehicles(vehicles, "")).toEqual(vehicles);
  });

  it("returns nothing for a query with no match", () => {
    expect(filterVehicles(vehicles, "CB500")).toEqual([]);
  });

  it("matches regardless of accents, in either direction", () => {
    expect(filterVehicles(vehicles, "bicicleta elétrica")).toEqual([vehicles[3]]);
    expect(filterVehicles(vehicles, "bicicleta eletrica")).toEqual([vehicles[3]]);
  });

  it("matches a colloquial category word to the vehicle's tipo", () => {
    expect(filterVehicles(vehicles, "bike elétrica")).toEqual([vehicles[3]]);
    expect(filterVehicles(vehicles, "scooter elétrica")).toEqual([vehicles[3]]);
    expect(filterVehicles(vehicles, "moto")).toEqual([vehicles[0], vehicles[1], vehicles[2]]);
  });

  it("does not assume a bare 'scooter' query means electric", () => {
    expect(filterVehicles(vehicles, "scooter")).toEqual([]);
  });

  it("matches by color or description text", () => {
    expect(filterVehicles(vehicles, "branco")).toEqual([vehicles[4]]);
    expect(filterVehicles(vehicles, "hidraulica")).toEqual([vehicles[4]]);
  });

  it("matches all query words regardless of their order in the model name", () => {
    // Real production case: catalog has "CG 160 - FAN - Basico" but the
    // customer said "fan 160" — word order differs, so a single-substring
    // match fails even though every word is present.
    const withFan = [
      ...vehicles,
      { id: 6, modelo: "CG 160 - FAN - Basico", marca: "HONDA", ano: 2026, preco: 15900, imageUrl: "/manus-storage/vehicles/fan.png", tipo: "moto" as const },
    ];
    expect(filterVehicles(withFan, "fan 160")).toEqual([withFan[5]]);
  });

  it("matches when the query combines words from different fields (brand + model)", () => {
    // "bros" only appears in modelo, "honda" only appears in marca — neither
    // field alone contains both words, so this needs a cross-field match.
    expect(filterVehicles(vehicles, "honda bros")).toEqual([vehicles[0]]);
  });

  it("matches a model written as one word when the catalog splits it with a space", () => {
    // Real production case: catalog has "MT 03 ABS" (space between letters
    // and digits) but the customer typed "mt03" as a single token — a plain
    // substring check fails because "mt03" never literally appears inside
    // "mt 03 abs". The agent told the customer the MT-03 wasn't in stock
    // when it was, then flip-flopped when a broader query happened to
    // surface it via the empty-query fallback.
    const withMt03 = [
      ...vehicles,
      { id: 7, modelo: "MT 03 ABS", marca: "YAMAHA", ano: 2026, preco: 38500, imageUrl: "/manus-storage/vehicles/mt03.png", tipo: "moto" as const },
    ];
    expect(filterVehicles(withMt03, "mt03")).toEqual([withMt03[5]]);
    expect(filterVehicles(withMt03, "mt-03")).toEqual([withMt03[5]]);
  });
});

describe("findVehicleByModel", () => {
  it("matches the exact model name, accent- and case-insensitive", () => {
    expect(findVehicleByModel(vehicles, "bros 160 esdd abs")).toBe(vehicles[0]);
  });

  it("matches a shortened or reworded model name", () => {
    expect(findVehicleByModel(vehicles, "Bicicleta Eletrica 350w — R$ 4.900")).toBe(vehicles[3]);
  });

  it("returns undefined when nothing matches", () => {
    expect(findVehicleByModel(vehicles, "CB500")).toBeUndefined();
  });
});

describe("getVehicleImageUrl", () => {
  it("resolves the vehicle's own imageUrl when present", () => {
    expect(getVehicleImageUrl(vehicles[0])).toBe("https://catalogo.motoetrilha.com.br/manus-storage/vehicles/bros.png");
  });

  it("falls back to the first extraImages entry when imageUrl is null", () => {
    // Real production case: the catalog's "FAZER FZ15 ABS CONNECTED" has
    // imageUrl: null but does have extraImages — sending null straight
    // into a URL template produced "...manus.spacenull", a broken link
    // the customer's WhatsApp app just failed to load silently.
    const vehicleWithOnlyExtraImages = {
      ...vehicles[0],
      imageUrl: null as unknown as string,
      extraImages: [{ url: "/manus-storage/vehicles/1786450742608_f55c92e6.png" }],
    };
    expect(getVehicleImageUrl(vehicleWithOnlyExtraImages)).toBe(
      "https://catalogo.motoetrilha.com.br/manus-storage/vehicles/1786450742608_f55c92e6.png"
    );
  });

  it("returns null when the vehicle has no image at all", () => {
    const vehicleWithNoImage = { ...vehicles[0], imageUrl: null as unknown as string, extraImages: [] };
    expect(getVehicleImageUrl(vehicleWithNoImage)).toBeNull();
  });
});

describe("formatVehicleList", () => {
  it("formats price in pt-BR currency style and resolves the full image URL", () => {
    const result = formatVehicleList([vehicles[0]]);
    expect(result).toBe(
      "- BROS 160 ESDD ABS (HONDA, 2026) — R$ 28.900 — foto: https://catalogo.motoetrilha.com.br/manus-storage/vehicles/bros.png"
    );
  });

  it("caps the list at 5 vehicles", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...vehicles[0], id: i, modelo: `MODEL ${i}` }));
    const result = formatVehicleList(many);
    expect(result.split("\n")).toHaveLength(5);
  });

  it("does not prefix an already-absolute imageUrl with the catalog host", () => {
    const absoluteUrlVehicle = {
      ...vehicles[3],
      imageUrl: "https://motos-img.autoflows.com.br/some-org/photo.png",
    };
    const result = formatVehicleList([absoluteUrlVehicle]);
    expect(result).toContain("foto: https://motos-img.autoflows.com.br/some-org/photo.png");
    expect(result).not.toContain("manus.spacehttps");
  });

  it("shows a 'no photo' placeholder instead of a corrupted URL when the vehicle has no image", () => {
    const vehicleWithNoImage = { ...vehicles[0], imageUrl: null as unknown as string };
    const result = formatVehicleList([vehicleWithNoImage]);
    expect(result).toContain("foto: sem foto disponível");
    expect(result).not.toContain("manus.spacenull");
  });

  it("includes color, mileage and description when the catalog provides them", () => {
    const result = formatVehicleList([vehicles[4]]);
    expect(result).toBe(
      "- CELTA LT (CHEVROLET, BRANCO, 2013, 180.000 km) — R$ 32.900 — Completo, com ar condicionado, direção hidráulica — foto: https://catalogo.motoetrilha.com.br/manus-storage/vehicles/celta.png"
    );
  });
});

describe("fetchCatalog", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries the catalog's Supabase REST API and maps image_url/vehicle_images onto imageUrl/extraImages", async () => {
    // Real production data: catalogo.motoetrilha.com.br (the new catalog
    // site) fetches vehicles from its own Supabase project directly from
    // the browser — this is that same request, replayed server-side.
    const row = {
      id: 63,
      modelo: "CG 160 START",
      marca: "HONDA",
      ano: 2025,
      quilometragem: 0,
      cor: "PRATA",
      preco: 21900,
      descricao: "",
      tipo: "moto",
      status: "available",
      image_url: "https://orpyesziyiknpebsnhvp.supabase.co/storage/v1/object/public/vehicle-photos/63/a.png",
      vehicle_images: [
        { id: 84, url: "https://orpyesziyiknpebsnhvp.supabase.co/storage/v1/object/public/vehicle-photos/63/a.png", ordem: 0, vehicle_id: 63 },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [row] });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchCatalog();

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("orpyesziyiknpebsnhvp.supabase.co/rest/v1/vehicles");
    expect(url).toContain("status=eq.available");
    expect(options.headers.apikey).toBeTruthy();
    expect(options.headers.Authorization).toBe(`Bearer ${options.headers.apikey}`);

    expect(result).toEqual([
      {
        id: 63,
        modelo: "CG 160 START",
        marca: "HONDA",
        ano: 2025,
        preco: 21900,
        imageUrl: row.image_url,
        extraImages: row.vehicle_images,
        tipo: "moto",
        cor: "PRATA",
        quilometragem: 0,
        descricao: "",
        status: "available",
      },
    ]);
  });

  it("throws when the catalog API responds with an error status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    await expect(fetchCatalog()).rejects.toThrow("Catalog API error 500");
  });
});

describe("buildCatalogSearchResult", () => {
  it("returns the formatted match list when the query hits", () => {
    const result = buildCatalogSearchResult(vehicles, "bros");
    expect(result).toContain("BROS 160 ESDD ABS");
    expect(result).not.toContain("Nenhum veículo encontrado");
  });

  it("falls back to suggesting other vehicles when nothing matches", () => {
    const result = buildCatalogSearchResult(vehicles, "CB500");
    expect(result).toContain('Nenhum veículo encontrado para "CB500"');
    expect(result).toContain("BROS 160 ESDD ABS");
    expect(result).toContain("YZF R15");
  });

  it("ranks fallback suggestions by word overlap instead of showing arbitrary vehicles", () => {
    // Real production case: a customer asked about the "XTZ 250 Lander ABS
    // Connected" — the LiberaCred program's reference name for this bike —
    // but the actual inventory lists it simply as "LANDER 250 ABS". "xtz"
    // and "connected" don't appear there, so the strict AND-match found
    // nothing, and the old vehicles.slice(0, 5) fallback (first 5 by
    // insertion order) showed unrelated vehicles instead of the Lander,
    // which sat further down the list — so the agent told the customer
    // "não encontrei a Lander" even though it was in stock with a photo.
    const withLander = [
      ...vehicles,
      { id: 7, modelo: "LANDER 250 ABS", marca: "YAMAHA", ano: 2026, preco: 34900, imageUrl: "/manus-storage/vehicles/lander.png", tipo: "moto" as const },
    ];
    const result = buildCatalogSearchResult(withLander, "XTZ 250 Lander ABS Connected");
    expect(result).toContain("LANDER 250 ABS");
  });

  it("includes at least one vehicle of each tipo in the fallback when nothing shares any word with the query", () => {
    // Real production case: a customer sent a photo of their own Volkswagen
    // Polo (a brand/model the catalog doesn't carry at all, so word overlap
    // is 0 for every vehicle). With 6+ motos ranked ahead of the dealership's
    // actual cars by insertion order alone, the old top-5-by-score fallback
    // showed only motorcycles and electric vehicles — no car anywhere in the
    // result — which led the agent to falsely tell the customer "não temos
    // carros no nosso catálogo" (they do: a Celta and a BMW are in stock).
    const manyMotos = Array.from({ length: 6 }, (_, i) => ({
      id: 10 + i,
      modelo: `MOTO ${i}`,
      marca: "HONDA",
      ano: 2026,
      preco: 20000,
      imageUrl: "/manus-storage/vehicles/moto.png",
      tipo: "moto" as const,
    }));
    const catalog = [...manyMotos, ...vehicles]; // vehicles[4] is the CELTA LT (tipo: carro)
    const result = buildCatalogSearchResult(catalog, "Volkswagen Polo");
    expect(result).toContain("CELTA LT");
  });

  it("surfaces every vehicle of an underrepresented tipo, not just one, when nothing matches", () => {
    // Real production case: a customer asked about financing an HB20 (a
    // Hyundai, not carried at all). The catalog has 3 cars in stock (BMW
    // 320i, Celta LT, HRV EX) among ~30 motorcycles. The old fallback only
    // guaranteed one vehicle per tipo, so it showed the BMW and buried the
    // other two cars behind motorcycles — the agent then told the customer
    // "temos só um carro (BMW 320i)", undercounting real inventory instead
    // of mentioning all three.
    const manyMotos = Array.from({ length: 6 }, (_, i) => ({
      id: 20 + i,
      modelo: `MOTO ${i}`,
      marca: "HONDA",
      ano: 2026,
      preco: 20000,
      imageUrl: "/manus-storage/vehicles/moto.png",
      tipo: "moto" as const,
    }));
    const threeCars = [
      { id: 30, modelo: "BMW 320I", marca: "BMW", ano: 2024, preco: 280000, imageUrl: "/manus-storage/vehicles/bmw.png", tipo: "carro" as const },
      { id: 31, modelo: "CELTA LT", marca: "CHEVROLET", ano: 2013, preco: 32900, imageUrl: "/manus-storage/vehicles/celta.png", tipo: "carro" as const },
      { id: 32, modelo: "HRV EX", marca: "HONDA", ano: 2022, preco: 120000, imageUrl: "/manus-storage/vehicles/hrv.png", tipo: "carro" as const },
    ];
    const catalog = [...manyMotos, ...threeCars];
    const result = buildCatalogSearchResult(catalog, "HB20");
    expect(result).toContain("BMW 320I");
    expect(result).toContain("CELTA LT");
    expect(result).toContain("HRV EX");
  });
});
