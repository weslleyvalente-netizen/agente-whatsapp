import type { AgentConfigSections } from "./types/agent-config.js";

const SECTION_KEYS = ["identity", "personality", "rules", "knowledge", "playbook"] as const;

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function computeChangedSections(
  draft: AgentConfigSections,
  baseSnapshot: AgentConfigSections | null
): Array<(typeof SECTION_KEYS)[number]> {
  if (!baseSnapshot) return [...SECTION_KEYS];
  return SECTION_KEYS.filter((key) => !deepEqual(draft[key], baseSnapshot[key]));
}
