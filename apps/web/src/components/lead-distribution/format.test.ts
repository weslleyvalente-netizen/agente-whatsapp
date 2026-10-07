import { describe, expect, it } from "vitest";
import { describeSla } from "./format";

const now = new Date("2026-10-05T12:00:00Z");
describe("describeSla", () => {
  it("mostra o tempo restante", () => {
    expect(describeSla("2026-10-05T12:15:00Z", now)).toEqual({ label: "15 min", overdue: false });
    expect(describeSla("2026-10-05T12:00:30Z", now)).toEqual({ label: "1 min", overdue: false });
  });
  it("mostra vencido", () => {
    expect(describeSla("2026-10-05T11:55:00Z", now)).toEqual({ label: "Vencido há 5 min", overdue: true });
    expect(describeSla("2026-10-05T12:00:00Z", now)).toEqual({ label: "Vencido há 0 min", overdue: true });
  });
  it("sem prazo, nada a mostrar", () => {
    expect(describeSla(null, now)).toBeNull();
  });
});
