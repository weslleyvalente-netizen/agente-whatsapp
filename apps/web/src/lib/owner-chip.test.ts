import { describe, expect, it } from "vitest";
import { ownerChip } from "./owner-chip";

describe("ownerChip", () => {
  it("mostra o nome do vendedor quando não há atribuição", () => {
    expect(ownerChip({ status: "open", owner_id: "u", owner_name: "Márcio", hasAssignment: false })).toEqual({ kind: "owner", label: "Márcio" });
  });
  it("sem dono em negócio aberto: Sem vendedor", () => {
    expect(ownerChip({ status: "open", owner_id: null, owner_name: null, hasAssignment: false })).toEqual({ kind: "none", label: "Sem vendedor" });
    expect(ownerChip({ status: "open", hasAssignment: false })).toEqual({ kind: "none", label: "Sem vendedor" });
  });
  it("dono que não é vendedor: nada", () => {
    expect(ownerChip({ status: "open", owner_id: "u", owner_name: null, hasAssignment: false })).toBeNull();
  });
  it("com lead_assignment: nada muda", () => {
    expect(ownerChip({ status: "open", owner_id: "u", owner_name: "Márcio", hasAssignment: true })).toBeNull();
    expect(ownerChip({ status: "open", owner_id: null, hasAssignment: true })).toBeNull();
  });
  it("negócio fechado/ganho/perdido: nada", () => {
    for (const status of ["won", "lost", "closed"]) expect(ownerChip({ status, owner_id: null, hasAssignment: false })).toBeNull();
  });
});
