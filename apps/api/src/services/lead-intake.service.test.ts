import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  getAllOrganizations,
  getAgentsByOrganization,
  getInstancesByOrganization,
  createMessage,
  updateConversation,
  upsertConversationQualification,
  ensureConversation,
  resolveApiKey,
  runAgent,
  enqueueSendMessage,
} = vi.hoisted(() => ({
  getAllOrganizations: vi.fn(),
  getAgentsByOrganization: vi.fn(),
  getInstancesByOrganization: vi.fn(),
  createMessage: vi.fn(),
  updateConversation: vi.fn(),
  upsertConversationQualification: vi.fn(),
  ensureConversation: vi.fn(),
  resolveApiKey: vi.fn(),
  runAgent: vi.fn(),
  enqueueSendMessage: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({
  getAllOrganizations,
  getAgentsByOrganization,
  getInstancesByOrganization,
  createMessage,
  updateConversation,
  upsertConversationQualification,
}));
vi.mock("@aula-agente/agent-runtime", () => ({ resolveApiKey, runAgent }));
vi.mock("./conversation.service.js", () => ({ ensureConversation }));
vi.mock("../lib/queue.js", () => ({ enqueueSendMessage }));

import { ingestWixLead, normalizeBrazilPhone } from "./lead-intake.service.js";

const org = { id: "org-1" };
const agent = { id: "agent-1", is_active: true, provider: "anthropic" };
const instance = { id: "instance-1", active_agent_id: "agent-1" };
const conversation = { id: "conv-1", organization_id: "org-1" };
const contact = { id: "contact-1" };

const lead = {
  name: "Jenerson",
  phone: "+55 62 99856-1435",
  interest: "Consórcio de Moto",
  budget: "Mais de R$ 1.500",
  priorExperience: "Não, vai ser a primeira vez",
};

describe("normalizeBrazilPhone", () => {
  it("strips formatting and keeps the country code", () => {
    expect(normalizeBrazilPhone("+55 62 99856-1435")).toBe("5562998561435");
  });

  it("prepends 55 when the country code is missing", () => {
    expect(normalizeBrazilPhone("(62) 99856-1435")).toBe("5562998561435");
  });
});

describe("ingestWixLead", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getAllOrganizations.mockResolvedValue([org]);
    getAgentsByOrganization.mockResolvedValue([agent]);
    getInstancesByOrganization.mockResolvedValue([instance]);
    resolveApiKey.mockResolvedValue("sk-test");
    createMessage.mockResolvedValue({ id: "msg-1" });
  });

  it("skips everything when there is no active agent", async () => {
    getAgentsByOrganization.mockResolvedValue([{ ...agent, is_active: false }]);

    const result = await ingestWixLead({} as any, lead);

    expect(result).toEqual({ ok: true, skipped: "no_agent" });
    expect(ensureConversation).not.toHaveBeenCalled();
  });

  it("does not send an opening message when the conversation already existed", async () => {
    ensureConversation.mockResolvedValue({ conversation, contact, isNew: false });

    const result = await ingestWixLead({} as any, lead);

    expect(result).toEqual({ ok: true, isNew: false });
    expect(runAgent).not.toHaveBeenCalled();
    expect(enqueueSendMessage).not.toHaveBeenCalled();
    expect(upsertConversationQualification).not.toHaveBeenCalled();
  });

  it("pre-fills qualification and has the agent open the conversation for a new lead", async () => {
    ensureConversation.mockResolvedValue({ conversation, contact, isNew: true });
    runAgent.mockResolvedValue({
      text: "Oi Jenerson! Vi seu interesse em consórcio de moto...",
      model: "claude",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheStatus: "none",
      latencyMs: 1,
      toolCalls: [],
    });

    const result = await ingestWixLead({} as any, lead);

    expect(upsertConversationQualification).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        conversationId: "conv-1",
        contactId: "contact-1",
        changedByType: "human",
        fields: expect.objectContaining({
          product_interest: "Consórcio de Moto",
          attendance_type: "consortium",
        }),
      })
    );
    expect(runAgent).toHaveBeenCalled();
    expect(enqueueSendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1", phone: "5562998561435" })
    );
    expect(updateConversation).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, isNew: true, sent: true });
  });

  it("still registers the lead but sends nothing when the agent has nothing to say", async () => {
    ensureConversation.mockResolvedValue({ conversation, contact, isNew: true });
    runAgent.mockResolvedValue({
      text: "",
      model: "claude",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheStatus: "none",
      latencyMs: 1,
      toolCalls: [],
    });

    const result = await ingestWixLead({} as any, lead);

    expect(enqueueSendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, isNew: true, sent: false });
  });
});
