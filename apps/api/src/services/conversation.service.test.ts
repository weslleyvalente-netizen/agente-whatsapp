import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("./returning-customer.service.js", () => ({
  resolveReturningCustomerOwnership: m.resolveReturningCustomerOwnership,
  createReturningCustomerDeps: vi.fn(() => ({})),
}));

import { ensureConversation } from "./conversation.service.js";

const params = {
  organizationId: "org-1", agentId: "agent-1", instanceId: "inst-1",
  phone: "556796077457", contactName: "Pedro Rangel", contactPhotoUrl: null,
};
const SELLER = "c3f31932-f949-49d0-885a-5581dfc0ec30";

beforeEach(() => {
  vi.clearAllMocks();
  m.findOpenConversation.mockResolvedValue(null);
  m.getOrganizationById.mockResolvedValue({ settings: {} });
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

  it("chave returning_customer_owner_enabled=false desliga a herança", async () => {
    m.getOrganizationById.mockResolvedValue({ settings: { returning_customer_owner_enabled: false } });
    m.resolveReturningCustomerOwnership.mockResolvedValue({ assignedTo: SELLER, keepHumanTakeover: true });
    const { conversation } = await ensureConversation(params);
    expect(m.resolveReturningCustomerOwnership).not.toHaveBeenCalled();
    expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false });
  });

  it("falha ao ler a organização não impede criar a conversa", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.getOrganizationById.mockRejectedValue(new Error("db fora"));
    const { conversation } = await ensureConversation(params);
    expect(conversation).toMatchObject({ assigned_to: null, is_human_takeover: false });
    spy.mockRestore();
  });

  it("nunca altera conversas antigas (nenhum updateConversation)", async () => {
    m.resolveReturningCustomerOwnership.mockResolvedValue({ assignedTo: SELLER, keepHumanTakeover: true });
    await ensureConversation(params);
    expect(m.updateConversation).not.toHaveBeenCalled();
  });
});
