import type { SupabaseClient } from "@aula-agente/database";
import { getTrainerMessageByProposalId, getTrainerSessionById, updateTrainerMessageProposals, patchAgentConfig } from "@aula-agente/database";
import type { AgentConfigDraft, TrainerProposal } from "@aula-agente/shared";

async function loadOwnedProposal(db: SupabaseClient, agentId: string, proposalId: string): Promise<{ message: Awaited<ReturnType<typeof getTrainerMessageByProposalId>>; proposal: TrainerProposal }> {
  const message = await getTrainerMessageByProposalId(db, proposalId);
  if (!message) throw new Error("Proposal not found");

  const session = await getTrainerSessionById(db, message.session_id);
  if (session.agent_id !== agentId) throw new Error("Proposal does not belong to this agent");

  const proposal = message.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error("Proposal not found");
  if (proposal.status !== "proposed") throw new Error("Proposal already decided");

  return { message, proposal };
}

export async function applyTrainerProposal(
  db: SupabaseClient,
  agentId: string,
  proposalId: string,
  updatedBy: string
): Promise<{ proposal: TrainerProposal; draft: AgentConfigDraft }> {
  const { message, proposal } = await loadOwnedProposal(db, agentId, proposalId);
  if (proposal.conflicts.length > 0 || !proposal.patch) {
    throw new Error("Cannot apply a proposal with unresolved conflicts");
  }

  const draft = await patchAgentConfig(db, agentId, proposal.patch, updatedBy);

  const appliedProposal: TrainerProposal = { ...proposal, status: "applied" };
  const updatedProposals = message!.proposals.map((p) => (p.id === proposalId ? appliedProposal : p));
  await updateTrainerMessageProposals(db, message!.id, updatedProposals);

  return { proposal: appliedProposal, draft };
}

export async function rejectTrainerProposal(db: SupabaseClient, agentId: string, proposalId: string): Promise<TrainerProposal> {
  const { message, proposal } = await loadOwnedProposal(db, agentId, proposalId);

  const rejectedProposal: TrainerProposal = { ...proposal, status: "rejected" };
  const updatedProposals = message!.proposals.map((p) => (p.id === proposalId ? rejectedProposal : p));
  await updateTrainerMessageProposals(db, message!.id, updatedProposals);

  return rejectedProposal;
}
