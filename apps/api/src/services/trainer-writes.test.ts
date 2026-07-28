import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// proposeConfigChange (trainer.service.ts) must never write anything — it
// only reads the draft and returns proposals for a human to approve. The
// only approved write path is applyTrainerProposal in
// trainer-decisions.service.ts, reached exclusively from the /apply route
// after an explicit human click. This proves that boundary at the source
// level, the same way agents-published-fields.test.ts proves the
// agents-table boundary.

const SERVICES_DIR = path.resolve(__dirname, ".");
const FORBIDDEN_PATTERNS = [
  /patchAgentConfig\s*\(/,
  /publishAgentConfig\s*\(/,
  /publish_agent_config/,
  /\.from\(\s*["'`]agents["'`]\s*\)/,
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
});
