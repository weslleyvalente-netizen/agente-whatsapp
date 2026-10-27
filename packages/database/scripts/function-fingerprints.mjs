#!/usr/bin/env node
// Imprime (nome, argumentos, md5(prosrc)) das funções que as migrações 20261027* substituem, depois de aplicar em PGlite TUDO que vem
// ANTES delas (distribuição de leads, pipeline, congelamento, gatilhos de dono e de tarefa humana). Compare com a lista de produção
// (SQL no runbook) ANTES de aplicar as 3 migrações novas: produção teve SQL aplicado à mão.
// Uso: pnpm --filter @aula-agente/database build && node packages/database/scripts/function-fingerprints.mjs [--check]
import { readFileSync } from "node:fs";
import { setupHandoffDb } from "../dist/sql/handoff-fixture.js";

export const FUNCTIONS = ["sync_sales_pipeline", "_lead_apply_effects", "distribute_lead", "redistribute_assignment", "manual_assign", "flag_sla_alerts"];
const { db } = await setupHandoffDb({ apply: [] }); // nenhuma das 3 migrações novas
const { rows } = await db.query(
  `select p.proname as name, pg_get_function_identity_arguments(p.oid) as args, md5(p.prosrc) as md5
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1) order by 1, 2`, [FUNCTIONS]);
const text = rows.map(r => `${r.name}\t${r.args}\t${r.md5}`).join("\n") + "\n";
if (process.argv.includes("--check")) {
  const expected = readFileSync(new URL("../../../docs/function-fingerprints-before-handoff-card.tsv", import.meta.url), "utf8");
  if (expected !== text) { console.error("DIFERENTE do esperado:\n" + text); process.exit(1); }
  console.log("OK: igual ao esperado");
} else process.stdout.write(text);
process.exit(0);
