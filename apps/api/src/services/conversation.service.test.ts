import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const m = vi.hoisted(() => ({
  getAdminClient: vi.fn(() => ({})),
  findOpenConversation: vi.fn(),
  createConversation: vi.fn(async (_db: unknown, c: Record<string, unknown>) => ({ id: "conv-nova", ...c })),
  updateConversation: vi.fn(),
  upsertContact: vi.fn(async () => ({ id: "contact-1" })),
  getOrganizationById: vi.fn(async () => ({ settings: {} as Record<string, unknown> })),
  resolveReturningCustomerOwnership: vi.fn(),
}));

vi.mock("@aula-agente/database", () => m);
const createDeps = vi.hoisted(() => vi.fn(() => ({})));
vi.mock("./returning-customer.service.js", () => ({
  resolveReturningCustomerOwnership: m.resolveReturningCustomerOwnership,
  createReturningCustomerDeps: createDeps,
}));

import { ensureConversation, RETURNING_OWNER_TIMEOUT_MS } from "./conversation.service.js";

const params = {
  organizationId: "org-1", agentId: "agent-1", instanceId: "inst-1",
  phone: "556796077457", contactName: "Pedro Rangel", contactPhotoUrl: null,
};
const SELLER = "c3f31932-f949-49d0-885a-5581dfc0ec30";

beforeEach(() => {
  vi.clearAllMocks();
  m.findOpenConversation.mockResolvedValue(null);
  m.getOrganizationById.mockResolvedValue({ settings: { returning_customer_owner_enabled: true } });
  m.resolveReturningCustomerOwnership.mockResolvedValue(null);
});

describe("ensureConversation — cliente que volta", () => {
  it("conversa aberta existente: reaproveita e não consulta herança", async () => {
    m.findOpenConversation.mockResolvedValue({ id: "conv-aberta" });
    const r = await ensureConversation(params);
    expect(r).toMatchObject({ isNew: false, conversation: { id: "conv-aberta" } });
    expect(m.resolveReturningCustomerOwnership).not.toHaveBeenCalled();
    expect(m.createConversation).not.toHaveBeenCalled();
  });

  it("Pedro: conversa anterior resolvida, retorno ≤ 24 h após atendimento humano → nova conversa com o vendedor e em takeover", async () => {
    m.resolveReturningCustomerOwnership.mockResolvedValue({ assignedTo: SELLER, keepHumanTakeover: true });
    const { conversation, isNew } = await ensureConversation(params);
    expect(isNew).toBe(true);
    expect(conversation).toMatchObject({ assigned_to: SELLER, is_human_takeover: true, status: "open" });
    expect(typeof (conversation as { human_takeover_at: unknown }).human_takeover_at).toBe("string");
  });

  it("depois das 24 h: vendedor mantido, MarIAna segue o fluxo normal (sem takeover)", async () => {
    m.resolveReturningCustomerOwnership.mockResolvedValue({ assignedTo: SELLER, keepHumanTakeover: false });
    const { conversation } = await ensureConversation(params);
    expect(conversation).toMatchObject({ assigned_to: SELLER, is_human_takeover: false, human_takeover_at: null });
  });

  it("cliente sem vendedor (ou vínculo inválido): igual a antes — sem dono, sem takeover", async () => {
    const { conversation } = await ensureConversation(params);
    expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false, human_takeover_at: null });
  });

  it.each([
    ["ausente (padrão)", {}],
    ["false", { returning_customer_owner_enabled: false }],
    ["valor que não é true", { returning_customer_owner_enabled: "true" }],
  ])("ativação explícita: chave %s não herda nada", async (_label, settings) => {
    m.getOrganizationById.mockResolvedValue({ settings });
    m.resolveReturningCustomerOwnership.mockResolvedValue({ assignedTo: SELLER, keepHumanTakeover: true });
    const { conversation } = await ensureConversation(params);
    expect(m.resolveReturningCustomerOwnership).not.toHaveBeenCalled();
    expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false, human_takeover_at: null });
  });

  it("falha ao ler a organização não impede criar a conversa", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.getOrganizationById.mockRejectedValue(new Error("db fora"));
    const { conversation } = await ensureConversation(params);
    expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false });
    spy.mockRestore();
  });

  describe("limite de tempo (banco que não responde)", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("configuração da organização trava: em 1,5 s cria a conversa normal, sem dono, e registra o timeout", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      m.getOrganizationById.mockReturnValue(new Promise(() => {}));
      const pending = ensureConversation(params);
      await vi.advanceTimersByTimeAsync(RETURNING_OWNER_TIMEOUT_MS);
      const { conversation, isNew } = await pending;
      expect(isNew).toBe(true);
      expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false, human_takeover_at: null });
      expect(JSON.parse(warn.mock.calls[0][0] as string)).toMatchObject({ event: "returning_owner_timeout", organizationId: "org-1", timeoutMs: RETURNING_OWNER_TIMEOUT_MS });
      warn.mockRestore();
    });

    it("consultas do vendedor travam (rpc sem resposta): mesmo fluxo normal, e o sinal de cancelamento é abortado", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      m.resolveReturningCustomerOwnership.mockReturnValue(new Promise(() => {}));
      const pending = ensureConversation(params);
      await vi.advanceTimersByTimeAsync(RETURNING_OWNER_TIMEOUT_MS);
      const { conversation } = await pending;
      expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false });
      const signal = (createDeps.mock.calls as unknown as Array<[unknown, AbortSignal]>)[0][1];
      expect(signal.aborted).toBe(true);
      warn.mockRestore();
    });

    it("resposta que chega depois do prazo é descartada (não aplica dono tardio)", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      m.resolveReturningCustomerOwnership.mockImplementation(() => new Promise((r) => setTimeout(() => r({ assignedTo: SELLER, keepHumanTakeover: true }), RETURNING_OWNER_TIMEOUT_MS + 500)));
      const pending = ensureConversation(params);
      await vi.advanceTimersByTimeAsync(RETURNING_OWNER_TIMEOUT_MS + 600);
      const { conversation } = await pending;
      expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false });
      warn.mockRestore();
    });

    it("dentro do prazo aplica normalmente", async () => {
      m.resolveReturningCustomerOwnership.mockImplementation(() => new Promise((r) => setTimeout(() => r({ assignedTo: SELLER, keepHumanTakeover: true }), 300)));
      const pending = ensureConversation(params);
      await vi.advanceTimersByTimeAsync(300);
      const { conversation } = await pending;
      expect(conversation).toMatchObject({ assigned_to: SELLER, is_human_takeover: true });
    });
  });

  it("nunca altera conversas antigas (nenhum updateConversation)", async () => {
    m.resolveReturningCustomerOwnership.mockResolvedValue({ assignedTo: SELLER, keepHumanTakeover: true });
    await ensureConversation(params);
    expect(m.updateConversation).not.toHaveBeenCalled();
  });
});
