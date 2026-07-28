import { describe, it, expect, vi, beforeEach } from "vitest";

const { getTrainerMessageByProposalId, getTrainerSessionById, updateTrainerMessageProposals, patchAgentConfig } = vi.hoisted(() => ({
  getTrainerMessageByProposalId: vi.fn(),
  getTrainerSessionById: vi.fn(),
  updateTrainerMessageProposals: vi.fn(),
  patchAgentConfig: vi.fn(),
}));

vi.mock("@aula-agente/database", () => ({ getTrainerMessageByProposalId, getTrainerSessionById, updateTrainerMessageProposals, patchAgentConfig }));

import { applyTrainerProposal, rejectTrainerProposal } from "./trainer-decisions.service.js";

const proposal = {
  id: "proposal-1", section: "personalidade" as const, item: "emojis",
  summary: "Aumentar emojis", rationale: "Pedido do usuário", conflicts: [], diff: [],
  patch: { personality: { tom_de_voz: "equilibrado", tom_de_voz_personalizado: "", tamanho_resposta: "curta", emojis: { ativo: true, maximo: 3, instrucao: "" }, perguntas_por_vez: { maximo: 1 }, postura_comercial: { tipo: "", instrucao: "" }, girias_proibidas: [], proatividade: "" } },
  status: "proposed" as const,
};

const message = { id: "message-1", session_id: "session-1", organization_id: "org-1", role: "assistant" as const, content: "ok", proposals: [proposal], created_at: "2026-01-01T00:00:00Z" };
const session = { id: "session-1", agent_id: "agent-1", organization_id: "org-1", created_by: "user-1", created_at: "2026-01-01T00:00:00Z" };

describe("applyTrainerProposal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getTrainerMessageByProposalId.mockResolvedValue(message);
    getTrainerSessionById.mockResolvedValue(session);
    patchAgentConfig.mockResolvedValue({ id: "draft-1" });
    updateTrainerMessageProposals.mockResolvedValue({ ...message, proposals: [{ ...proposal, status: "applied" }] });
  });

  it("calls patchAgentConfig with exactly the proposal's patch and marks it applied", async () => {
    const result = await applyTrainerProposal({} as any, "agent-1", "proposal-1", "user-1");

    expect(patchAgentConfig).toHaveBeenCalledWith({}, "agent-1", proposal.patch, "user-1");
    expect(result.proposal.status).toBe("applied");
    expect(updateTrainerMessageProposals).toHaveBeenCalledWith({}, "message-1", [expect.objectContaining({ id: "proposal-1", status: "applied" })]);
  });

  it("throws and never calls patchAgentConfig when the proposal still has unresolved conflicts", async () => {
    getTrainerMessageByProposalId.mockResolvedValue({
      ...message,
      proposals: [{ ...proposal, conflicts: [{ description: "x", section: "personalidade", item: null, resolution_options: [] }], patch: null }],
    });

    await expect(applyTrainerProposal({} as any, "agent-1", "proposal-1", "user-1")).rejects.toThrow();
    expect(patchAgentConfig).not.toHaveBeenCalled();
  });

  it("throws when the proposal's session does not belong to the given agent", async () => {
    getTrainerSessionById.mockResolvedValue({ ...session, agent_id: "other-agent" });

    await expect(applyTrainerProposal({} as any, "agent-1", "proposal-1", "user-1")).rejects.toThrow();
    expect(patchAgentConfig).not.toHaveBeenCalled();
  });
});

describe("rejectTrainerProposal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getTrainerMessageByProposalId.mockResolvedValue(message);
    getTrainerSessionById.mockResolvedValue(session);
    updateTrainerMessageProposals.mockResolvedValue({ ...message, proposals: [{ ...proposal, status: "rejected" }] });
  });

  it("marks the proposal rejected and never calls patchAgentConfig", async () => {
    const result = await rejectTrainerProposal({} as any, "agent-1", "proposal-1");

    expect(result.status).toBe("rejected");
    expect(patchAgentConfig).not.toHaveBeenCalled();
  });
});
