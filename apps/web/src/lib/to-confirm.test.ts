// Aba "A confirmar" (decisão do dono 25/11): cards com operation_is_default saem do funil de venda de veículos e ficam numa aba própria.
import { describe, expect, it } from "vitest";
import { TO_CONFIRM, tabOf, filterForTab, countsByTab, confirmPlan } from "./to-confirm";

const o = (operation: string, operation_is_default = false, stage = "interest_received") => ({ operation, operation_is_default, stage }) as any;

describe("aba A confirmar", () => {
  it("card com produto a confirmar vai só para a aba A confirmar (nunca para Venda de veículos)", () => {
    expect(tabOf(o("vehicle_sale", true))).toBe(TO_CONFIRM);
    expect(tabOf(o("vehicle_sale"))).toBe("vehicle_sale");
    const list = [o("vehicle_sale", true), o("vehicle_sale"), o("consortium")];
    expect(filterForTab(list, "vehicle_sale")).toHaveLength(1);
    expect(filterForTab(list, TO_CONFIRM)).toHaveLength(1);
  });

  it("contadores: indefinidos fora de Venda de veículos, mas dentro do total geral", () => {
    const c = countsByTab([o("vehicle_sale", true), o("vehicle_sale", true), o("vehicle_sale"), o("consortium")]);
    expect(c.get(TO_CONFIRM)).toBe(2);
    expect(c.get("vehicle_sale")).toBe(1);
    expect([...c.values()].reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("confirmar preserva a etapa quando ela existe no funil de destino; senão o funil começa na primeira etapa", () => {
    expect(confirmPlan(o("vehicle_sale", true, "qualification"), "contemplated_letter")).toEqual({ operation: "contemplated_letter", restoreStage: "qualification" });
    expect(confirmPlan(o("vehicle_sale", true, "interest_received"), "consortium")).toEqual({ operation: "consortium", restoreStage: null });
    expect(confirmPlan(o("vehicle_sale", true, "proposal_sent"), "consortium")).toEqual({ operation: "consortium", restoreStage: null });
    expect(confirmPlan(o("vehicle_sale", true, "proposal_sent"), "contemplated_letter")).toEqual({ operation: "contemplated_letter", restoreStage: "proposal_sent" });
  });

  it("confirmar como venda de veículo também tira da aba (a API limpa a marca ao gravar a operação)", () => {
    expect(confirmPlan(o("vehicle_sale", true, "qualification"), "vehicle_sale")).toEqual({ operation: "vehicle_sale", restoreStage: "qualification" });
  });
});
