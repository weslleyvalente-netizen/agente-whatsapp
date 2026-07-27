import type { z } from "zod";
import type { SectionKey } from "../agent-config-sections.js";
import type { updateAgentConfigSchema } from "../schemas/agent-config.js";

export type TrainerProposalStatus = "proposed" | "approved" | "rejected" | "applied";

export interface TrainerConflict {
  description: string;
  section: SectionKey;
  item: string | null;
  resolution_options: string[];
}

export interface TrainerProposalDiffEntry {
  field_path: string;
  before: unknown;
  after: unknown;
}

export type UpdateAgentConfigPatch = z.infer<typeof updateAgentConfigSchema>;

export interface TrainerProposal {
  id: string;
  section: SectionKey;
  item: string | null;
  summary: string;
  rationale: string;
  conflicts: TrainerConflict[];
  diff: TrainerProposalDiffEntry[];
  patch: UpdateAgentConfigPatch | null;
  status: TrainerProposalStatus;
}

export interface AgentTrainerSession {
  id: string;
  agent_id: string;
  organization_id: string;
  created_by: string;
  created_at: string;
}

export interface AgentTrainerMessage {
  id: string;
  session_id: string;
  organization_id: string;
  role: "user" | "assistant";
  content: string;
  proposals: TrainerProposal[];
  created_at: string;
}
