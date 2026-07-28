import type { SupabaseClient } from "@aula-agente/database";
import { getTrainerMessageByProposalId, getTrainerSessionById, updateTrainerMessageProposals, patchAgentConfig } from "@aula-agente/database";
import type { AgentConfigDraft, AgentTrainerMessage, TrainerProposal } from "@aula-agente/shared";

async function loadOwnedProposal(db: SupabaseClient, agentId: string, proposalId: string): Promise<{ message: AgentTrainerMessage; proposal: TrainerProposal }> {
  const message = await getTrainerMessageByProposalId(db, proposalId);
  if (!message) throw new Error("Proposal not found");

  const session = await getTrainerSessionById(db, message.session_id);
  if (session.agent_id !== agentId) throw new Error("Proposal does not belong to this agent");

  const proposal = message.proposals.find((p) => p.id === proposalId);
  if (!proposal) throw new Error("Proposal not found");
  // Guards against re-deciding an already-applied/rejected proposal — this is
  // the sole barrier preventing a proposal's patch from being applied twice.
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
  if (proposal.conflicts.length > 0) {
    throw new Error("Cannot apply a proposal with unresolved conflicts");
  }
  if (!proposal.patch) {
    throw new Error("Cannot apply a proposal with no patch");
  }

  // NOTE: these two writes are not atomic and there is no compare-and-swap on
  // either. If patchAgentConfig succeeds but updateTrainerMessageProposals
  // then fails (network blip, process crash, etc.), the agent_configs row is
  // durably patched while this proposal's status remains "proposed" — which
  // reopens the double-apply risk the status guard above exists to prevent
  // (a retry would call patchAgentConfig again). Additionally,
  // updateTrainerMessageProposals does a blind whole-array overwrite with no
  // optimistic locking, so two concurrent applies of the same proposal, or
  // concurrent decisions on two different proposals in the same message, can
  // race and clobber each other. Fixing this properly requires a
  // compare-and-swap in the Task 8 query layer (updateTrainerMessageProposals)
  // and/or a saga/outbox pattern here; out of scope for this file today —
  // any future change touching this sequence should consciously decide
  // whether to address it.
  const draft = await patchAgentConfig(db, agentId, proposal.patch, updatedBy);

  const appliedProposal: TrainerProposal = { ...proposal, status: "applied" };
  const updatedProposals = message.proposals.map((p) => (p.id === proposalId ? appliedProposal : p));
  await updateTrainerMessageProposals(db, message.id, updatedProposals);

  return { proposal: appliedProposal, draft };
}

export async function rejectTrainerProposal(db: SupabaseClient, agentId: string, proposalId: string): Promise<TrainerProposal> {
  const { message, proposal } = await loadOwnedProposal(db, agentId, proposalId);

  // NOTE: same lack-of-compare-and-swap caveat as applyTrainerProposal above —
  // updateTrainerMessageProposals overwrites the whole proposals array, so a
  // concurrent decision on another proposal in this same message can race
  // with this write. There's no second write to leave inconsistent here
  // (rejecting never touches agent_configs), but the race on the proposals
  // array itself is still possible.
  const rejectedProposal: TrainerProposal = { ...proposal, status: "rejected" };
  const updatedProposals = message.proposals.map((p) => (p.id === proposalId ? rejectedProposal : p));
  await updateTrainerMessageProposals(db, message.id, updatedProposals);

  return rejectedProposal;
}
