import { describe, expect, it } from "vitest";
import { voidActions, voidReasonError, statusLabel } from "./opportunity-void";

describe("anulação de negócio (tela)", () => {
  it("só gestor vê anular (em aberto, ganho ou perdido) e desfazer (em anulado); vendedor só vê o aviso", () => {
    expect(voidActions("won", true)).toEqual({ canVoid: true, canUnvoid: false, isVoid: false });
    expect(voidActions("open", false)).toEqual({ canVoid: false, canUnvoid: false, isVoid: false });
    expect(voidActions("void", true)).toEqual({ canVoid: false, canUnvoid: true, isVoid: true });
    expect(voidActions("void", false)).toEqual({ canVoid: false, canUnvoid: false, isVoid: true });
  });
  it("motivo obrigatório de 10 a 500 caracteres (mesma regra da API e do banco)", () => {
    expect(voidReasonError("  curto ")).toMatch(/10/);
    expect(voidReasonError("x".repeat(501))).toMatch(/500/);
    expect(voidReasonError("Pós-venda via cadastro @lid duplicado")).toBeNull();
  });
  it("rótulo de status inclui Anulado (antes caía em 'Em andamento')", () => {
    expect(["open", "won", "lost", "void"].map(statusLabel)).toEqual(["Em andamento", "Ganho", "Perdido", "Anulado"]);
  });
});
