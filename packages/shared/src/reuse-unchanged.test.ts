import { describe, expect, it } from "vitest";
import { reuseUnchanged } from "./reuse-unchanged.js";

describe("reuseUnchanged", () => {
  const a = { id: "a", n: 1 }, b = { id: "b", n: 2 };
  it("devolve a lista anterior (mesma referência) quando nada mudou", () => {
    const prev = [a, b];
    expect(reuseUnchanged(prev, [{ ...a }, { ...b }])).toBe(prev);
  });
  it("reaproveita a referência dos itens inalterados e troca só os alterados", () => {
    const out = reuseUnchanged([a, b], [{ ...a }, { id: "b", n: 3 }]);
    expect(out[0]).toBe(a);
    expect(out[1]).toEqual({ id: "b", n: 3 });
  });
  it("trata item novo, removido e reordenado", () => {
    const out = reuseUnchanged([a, b], [b, { id: "c", n: 9 }]);
    expect(out[0]).toBe(b);
    expect(out.map(x => x.id)).toEqual(["b", "c"]);
  });
  it("lista anterior vazia devolve a nova", () => {
    const next = [a];
    expect(reuseUnchanged([], next)).toBe(next);
  });
});
