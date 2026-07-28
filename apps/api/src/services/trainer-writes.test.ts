import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// proposeConfigChange (trainer.service.ts) must never mutate an existing
// draft or write anything at all — it only reads the draft (via the
// read-only getAgentConfigIfExists, falling back to an in-memory default)
// and returns proposals for a human to approve. The only approved write
// path is applyTrainerProposal in trainer-decisions.service.ts, reached
// exclusively from the /apply route after an explicit human click. This
// proves that boundary at the source level, the same way
// agents-published-fields.test.ts proves the agents-table boundary.

const SERVICES_DIR = path.resolve(__dirname, ".");
const ROUTES_FILE = path.resolve(__dirname, "../routes/agent-config/index.ts");

const FORBIDDEN_PATTERNS = [
  /patchAgentConfig\s*\(/,
  /publishAgentConfig\s*\(/,
  /publish_agent_config/,
  /\.from\(\s*["'`]agents["'`]\s*\)/,
  // Named helpers aren't the only way to write: the Supabase client itself
  // can mutate directly. Forbid the mutating verbs and any reference to the
  // agent_configs table, so a future change can't bypass patchAgentConfig
  // and write the draft by hand while this test stays green.
  /\.(update|insert|upsert|delete)\s*\(/,
  /\.from\(\s*["'`]agent_configs["'`]\s*\)/,
];

function read(file: string): string {
  return readFileSync(path.join(SERVICES_DIR, file), "utf-8");
}

describe("trainer write boundary", () => {
  it("trainer.service.ts (proposal generation) never writes agent_configs, publishes, or touches agents", () => {
    const content = read("trainer.service.ts");
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });

  it("trainer-decisions.service.ts is the only place calling patchAgentConfig for the Trainer, and never publishes", () => {
    const content = read("trainer-decisions.service.ts");
    expect(content.match(/patchAgentConfig\s*\(/g)?.length ?? 0).toBe(1);
    expect(content).not.toMatch(/publishAgentConfig\s*\(/);
    expect(content).not.toMatch(/publish_agent_config/);
    expect(content).not.toMatch(/\.from\(\s*["'`]agents["'`]\s*\)/);
  });

  it("the agent-config routes file has exactly one patchAgentConfig call — the non-Trainer PATCH /config handler", () => {
    const content = readFileSync(ROUTES_FILE, "utf-8");

    // All 5 Trainer routes live in this same file, alongside the
    // pre-existing (and legitimate) PATCH /agents/:agentId/config handler
    // that calls patchAgentConfig directly. So the count is pinned at 1
    // rather than 0: 1 means "only the old non-Trainer handler writes".
    // Any Trainer route that grew its own write path would push this to 2
    // and fail here — that's the regression this guards.
    expect(content.match(/patchAgentConfig\s*\(/g)?.length ?? 0).toBe(1);
  });
});
