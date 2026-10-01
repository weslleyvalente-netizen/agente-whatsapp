import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// publish_agent_config (supabase/migrations/00016_publish_agent_config_function.sql)
// is the ONLY writer of agents.system_prompt/model/provider/temperature/
// max_tokens/tools_config — the draft (agent_configs) is never allowed to
// touch them directly, and no other code path should either. These tests
// guard that invariant at the source level, since a plain `.update()` call
// on the `agents` table would silently bypass versioning/history.

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SCAN_DIRS = [
  "packages/database/src",
  "packages/agent-runtime/src",
  "packages/shared/src",
  "packages/queue/src",
  "apps/api/src",
  "apps/worker/src",
  "apps/web/src",
];
const SKIP_DIR_NAMES = new Set(["node_modules", "dist", ".next", ".turbo"]);

function listSourceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("agents table published-field write path", () => {
  it("has no direct .update() call on the agents table anywhere in source (publish_agent_config is the only writer)", () => {
    const updateOnAgentsPattern = /\.from\(\s*["'`]agents["'`]\s*\)[\s\S]{0,150}?\.update\s*\(/;
    const offenders: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const file of listSourceFiles(path.join(REPO_ROOT, dir))) {
        const content = readFileSync(file, "utf-8");
        if (updateOnAgentsPattern.test(content)) {
          offenders.push(path.relative(REPO_ROOT, file));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("published-field writes stay inside the two versioned publishing migrations", () => {
    const migrationsDir = path.join(REPO_ROOT, "supabase/migrations");
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

    const filesUpdatingAgents = files.filter((f) =>
      /UPDATE\s+agents\s+SET/i.test(readFileSync(path.join(migrationsDir, f), "utf-8"))
    );
    expect(filesUpdatingAgents.sort()).toEqual(["00016_publish_agent_config_function.sql", "20260930233509_sync_published_agent_name.sql"]);

    const sql = readFileSync(path.join(migrationsDir, "00016_publish_agent_config_function.sql"), "utf-8");
    const currentSql=readFileSync(path.join(migrationsDir,"20260930233509_sync_published_agent_name.sql"),"utf-8");
    const currentSet=currentSql.match(/UPDATE\s+agents\s+SET([\s\S]*?)WHERE/i)?.[1]??"";
    expect([...currentSet.matchAll(/^\s*(\w+)\s*=/gm)].map(m=>m[1]).sort()).toEqual(["name","system_prompt","model","provider","temperature","max_tokens","tools_config"].sort());
    expect(currentSql).toContain("a.system_prompt = v.compiled_system_prompt");
    expect(currentSql).toContain("from agent_versions order by agent_id, version desc");
    const setClause = sql.match(/UPDATE\s+agents\s+SET([\s\S]*?)WHERE/i)?.[1] ?? "";
    const setColumns = [...setClause.matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);

    expect(setColumns.sort()).toEqual(
      ["system_prompt", "model", "provider", "temperature", "max_tokens", "tools_config"].sort()
    );
  });

  it("no longer exports a generic updateAgent() from @aula-agente/database", () => {
    const agentsQueriesSource = readFileSync(
      path.join(REPO_ROOT, "packages/database/src/queries/agents.ts"),
      "utf-8"
    );
    expect(agentsQueriesSource).not.toMatch(/export\s+(async\s+)?function\s+updateAgent\b/);
  });
});
