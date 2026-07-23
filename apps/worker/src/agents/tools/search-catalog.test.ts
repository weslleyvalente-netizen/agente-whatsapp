import { describe, it, expect } from "vitest";
import { filterVehicles, formatVehicleList, buildCatalogSearchResult } from "./search-catalog.js";

const vehicles = [
  { id: 1, modelo: "BROS 160 ESDD ABS", marca: "HONDA", ano: 2026, preco: 28900, imageUrl: "/manus-storage/vehicles/bros.png", tipo: "moto" as const },
  { id: 2, modelo: "YZF R15 - 155 ABS Gas", marca: "YAMAHA", ano: 2026, preco: 28900, imageUrl: "/manus-storage/vehicles/r15.png", tipo: "moto" as const },
  { id: 3, modelo: "AVELLOZ AZ1 50CC", marca: "AVELLOZ", ano: 2026, preco: 13900, imageUrl: "/manus-storage/vehicles/az1.png", tipo: "moto" as const },
  { id: 4, modelo: "Bicicleta Eletrica 350w", marca: "ELÉTRICA", ano: 2026, preco: 4900, imageUrl: "/manus-storage/vehicles/bike.png", tipo: "eletrico" as const },
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
});

describe("formatVehicleList", () => {
  it("formats price in pt-BR currency style and resolves the full image URL", () => {
    const result = formatVehicleList([vehicles[0]]);
    expect(result).toBe(
      "- BROS 160 ESDD ABS (HONDA, 2026) — R$ 28.900 — foto: https://catalogomotoetrilha.manus.space/manus-storage/vehicles/bros.png"
    );
  });

  it("caps the list at 5 vehicles", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ ...vehicles[0], id: i, modelo: `MODEL ${i}` }));
    const result = formatVehicleList(many);
    expect(result.split("\n")).toHaveLength(5);
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
});
