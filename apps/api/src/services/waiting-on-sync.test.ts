import { describe, expect, it, vi } from "vitest";

// A lógica (e os testes dela) vive em packages/database/src/queries/waiting-on-sync*.ts. Aqui só o contrato do invólucro da API:
// nunca lança, nem quando o módulo de banco simulado nem sequer tem as funções.
vi.mock("@aula-agente/database", () => ({ syncWaitingOnAfterSellerMessage: vi.fn().mockRejectedValue(new Error("db down")) }));
import { syncWaitingOnAfterCustomerReply, syncWaitingOnAfterHumanCompletion, syncWaitingOnAfterSellerMessage } from "./waiting-on-sync.js";

describe("invólucro da sincronização de waiting_on na API", () => {
  it("devolve 'error' (e não lança) quando a função de banco falha", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await syncWaitingOnAfterSellerMessage({} as never, { organizationId: "o", contactId: "c", role: "human_agent", content: "x" })).toBe("error");
    spy.mockRestore();
  });
  it("devolve 'error' (e não lança) quando a função nem existe no módulo", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await syncWaitingOnAfterCustomerReply({} as never, { organizationId: "o", contactId: "c", role: "contact", content: "x" })).toBe("error");
    expect(await syncWaitingOnAfterHumanCompletion({} as never, {} as never)).toBe("error");
    spy.mockRestore();
  });
});
