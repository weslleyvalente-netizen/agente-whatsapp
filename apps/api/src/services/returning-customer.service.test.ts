import { describe, it, expect, vi } from "vitest";

vi.mock("@aula-agente/database", () => ({ getOrganizationById: vi.fn() }));

import {
  resolveReturningCustomerOwnership,
  RETURN_HUMAN_WINDOW_MS,
  type ReturningCustomerDeps,
} from "./returning-customer.service.js";

const PEDRO = { org: "org-1", contact: "805685", previous: "4df0e974", seller: "c3f31932-f949-49d0-885a-5581dfc0ec30" };
const NOW = new Date("2026-11-13T21:50:34Z");

function makeDeps(over: Partial<ReturningCustomerDeps> = {}): ReturningCustomerDeps {
  return {
    getOwnerLookbackDays: vi.fn().mockResolvedValue(30),
    getPreviousConversation: vi.fn().mockResolvedValue({ id: PEDRO.previous }),
    resolveCurrentOwner: vi.fn().mockResolvedValue({ repId: "rep-1", outcome: "found" }),
    getRepUserId: vi.fn().mockResolvedValue(PEDRO.seller),
    getLastHumanMessageAt: vi.fn().mockResolvedValue(new Date("2026-11-13T20:46:30Z")),
    ...over,
  };
}
const run = (deps: ReturningCustomerDeps) =>
  resolveReturningCustomerOwnership(deps, { organizationId: PEDRO.org, contactId: PEDRO.contact, now: NOW });

describe("resolveReturningCustomerOwnership", () => {
  it("cenário do Pedro: voltou 64 min depois do áudio do vendedor → mantém o vendedor e a conversa nasce em takeover", async () => {
    const deps = makeDeps();
    expect(await run(deps)).toEqual({ assignedTo: PEDRO.seller, keepHumanTakeover: true });
    expect(deps.resolveCurrentOwner).toHaveBeenCalledWith({
      organizationId: PEDRO.org, contactId: PEDRO.contact, conversationId: PEDRO.previous, lookbackDays: 30,
    });
  });

  it("exatamente 24 h depois do último atendimento humano ainda conta como dentro da janela", async () => {
    const at = new Date(NOW.getTime() - RETURN_HUMAN_WINDOW_MS);
    expect(await run(makeDeps({ getLastHumanMessageAt: vi.fn().mockResolvedValue(at) }))).toMatchObject({ keepHumanTakeover: true });
  });

  it("passou das 24 h: mantém o vendedor, mas a MarIAna segue o fluxo normal (sem takeover)", async () => {
    const at = new Date(NOW.getTime() - RETURN_HUMAN_WINDOW_MS - 1000);
    expect(await run(makeDeps({ getLastHumanMessageAt: vi.fn().mockResolvedValue(at) }))).toEqual({
      assignedTo: PEDRO.seller, keepHumanTakeover: false,
    });
  });

  it("conversa anterior sem nenhuma mensagem humana: mantém o vendedor, sem takeover", async () => {
    expect(await run(makeDeps({ getLastHumanMessageAt: vi.fn().mockResolvedValue(null) }))).toEqual({
      assignedTo: PEDRO.seller, keepHumanTakeover: false,
    });
  });

  it("cliente sem conversa anterior (lead novo): não herda nada e nem consulta o dono", async () => {
    const deps = makeDeps({ getPreviousConversation: vi.fn().mockResolvedValue(null) });
    expect(await run(deps)).toBeNull();
    expect(deps.resolveCurrentOwner).not.toHaveBeenCalled();
  });

  it.each(["none", "invalid", "conflict"])("cliente sem vendedor válido (%s): conversa nova sem dono, como hoje", async (outcome) => {
    const deps = makeDeps({ resolveCurrentOwner: vi.fn().mockResolvedValue({ repId: null, outcome }) });
    expect(await run(deps)).toBeNull();
    expect(deps.getRepUserId).not.toHaveBeenCalled();
  });

  it("vendedor desligado ou redistribuído pelo gestor vem como 'none'/'found' de outro vendedor: respeita o que a regra oficial decidir", async () => {
    // gestor passou o negócio para outro vendedor: a regra oficial devolve o dono atual do negócio, não o da conversa antiga
    const deps = makeDeps({
      resolveCurrentOwner: vi.fn().mockResolvedValue({ repId: "rep-novo", outcome: "found" }),
      getRepUserId: vi.fn().mockResolvedValue("user-novo"),
    });
    expect(await run(deps)).toMatchObject({ assignedTo: "user-novo" });
    expect(deps.getRepUserId).toHaveBeenCalledWith(PEDRO.org, "rep-novo");
  });

  it("vendedor encontrado mas sem usuário cadastrado: não herda", async () => {
    expect(await run(makeDeps({ getRepUserId: vi.fn().mockResolvedValue(null) }))).toBeNull();
  });

  it("qualquer falha de leitura vira null (nunca atrasa nem derruba o atendimento)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(makeDeps({ resolveCurrentOwner: vi.fn().mockRejectedValue(new Error("db fora")) }))).toBeNull();
    spy.mockRestore();
  });

  it("usa a janela de dias configurada na organização", async () => {
    const deps = makeDeps({ getOwnerLookbackDays: vi.fn().mockResolvedValue(7) });
    await run(deps);
    expect(deps.resolveCurrentOwner).toHaveBeenCalledWith(expect.objectContaining({ lookbackDays: 7 }));
  });
});
