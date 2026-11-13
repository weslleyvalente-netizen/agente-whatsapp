#!/usr/bin/env node
// Valida a migração 20261113120000_lead_ad_touches.sql e a view opportunity_ad_origins num Postgres 16 em memória (PGlite),
// DENTRO de uma transação que termina em ROLLBACK, e compara a atribuição da view com os cenários em
// supabase/tests/ad-attribution-scenarios.json, os MESMOS que a API testa (apps/api/src/services/ad-attribution-scenarios.test.ts).
//
// Uso (PGlite não é dependência do repositório):
//   npm install --no-save @electric-sql/pglite && node scripts/validate-ad-attribution-view.mjs
// ou, com o PGlite instalado em outra pasta: PGLITE_PATH=/caminho/node_modules/@electric-sql/pglite/dist/index.js node scripts/validate-ad-attribution-view.mjs
// Sai com código 1 se algum cenário divergir. Nada é gravado em banco algum.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const { PGlite } = await import(process.env.PGLITE_PATH ?? "@electric-sql/pglite");
const root = fileURLToPath(new URL("..", import.meta.url));
const migration = readFileSync(`${root}supabase/migrations/20261113120000_lead_ad_touches.sql`, "utf8");
const { organization, scenarios } = JSON.parse(readFileSync(`${root}supabase/tests/ad-attribution-scenarios.json`, "utf8"));

// Nomes legíveis dos cenários viram UUIDs determinísticos (as colunas da migração são uuid).
const uuid = (name) => {
  const h = createHash("md5").update(String(name)).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const ids = new Map();
const idOf = (kind, name) => { const key = `${kind}:${name}`; if (!ids.has(key)) ids.set(key, uuid(key)); return ids.get(key); };

const db = new PGlite();
let failures = 0;
const report = [];

await db.exec("BEGIN");
try {
  // Tabelas-pai mínimas (no Supabase já existem); só as colunas que a migração e a view usam.
  await db.exec(`
    CREATE TABLE public.organizations (id uuid PRIMARY KEY);
    CREATE TABLE public.wa_contacts (id uuid PRIMARY KEY);
    CREATE TABLE public.conversations (id uuid PRIMARY KEY);
    CREATE TABLE public.opportunities (id uuid PRIMARY KEY, organization_id uuid NOT NULL, contact_id uuid NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE public.lead_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL, opportunity_id uuid, conversation_id uuid);
  `);

  // 1) A migração real, sem alteração; depois uma segunda vez para provar que é idempotente.
  await db.exec(migration);
  await db.exec(migration);
  const objects = await db.query(`
    SELECT (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename='lead_ad_touches') AS tabela,
           (SELECT count(*) FROM pg_views WHERE schemaname='public' AND viewname='opportunity_ad_origins') AS visao,
           (SELECT relrowsecurity FROM pg_class WHERE oid='public.lead_ad_touches'::regclass) AS rls,
           (SELECT count(*) FROM pg_policies WHERE tablename='lead_ad_touches') AS policies,
           (SELECT count(*) FROM pg_indexes WHERE tablename='lead_ad_touches') AS indices`);
  const o = objects.rows[0];
  const okObjects = Number(o.tabela) === 1 && Number(o.visao) === 1 && o.rls === true && Number(o.policies) === 0 && Number(o.indices) >= 4;
  report.push({ verificação: "migração (aplicada 2x, idempotente): tabela, view, RLS ligada, 0 policies, índices", resultado: okObjects ? "OK" : `FALHOU ${JSON.stringify(o)}` });
  if (!okObjects) failures++;

  // 2) Cenários: mesmos dados, mesma expectativa da API.
  await db.query("INSERT INTO public.organizations (id) VALUES ($1)", [idOf("org", organization)]);
  for (const s of scenarios) {
    await db.query("INSERT INTO public.wa_contacts (id) VALUES ($1)", [idOf("contact", s.contact)]);
    await db.query("INSERT INTO public.opportunities (id, organization_id, contact_id, created_at) VALUES ($1,$2,$3,$4)",
      [idOf("opp", s.opportunity.id), idOf("org", organization), idOf("contact", s.contact), s.opportunity.created_at]);
    for (const c of s.opportunity.linked_conversations) {
      await db.query("INSERT INTO public.conversations (id) VALUES ($1) ON CONFLICT DO NOTHING", [idOf("conv", `${s.contact}/${c}`)]);
      await db.query("INSERT INTO public.lead_assignments (organization_id, opportunity_id, conversation_id) VALUES ($1,$2,$3)",
        [idOf("org", organization), idOf("opp", s.opportunity.id), idOf("conv", `${s.contact}/${c}`)]);
    }
    for (const t of s.touches) {
      const conv = t.conversation_id ? idOf("conv", `${s.contact}/${t.conversation_id}`) : null;
      if (conv) await db.query("INSERT INTO public.conversations (id) VALUES ($1) ON CONFLICT DO NOTHING", [conv]);
      await db.query(
        `INSERT INTO public.lead_ad_touches (id, organization_id, contact_id, conversation_id, touched_at, platform, touch_key)
         VALUES ($1,$2,$3,$4,$5,'instagram',$6)`,
        [idOf("touch", `${s.contact}/${t.id}`), idOf("org", organization), idOf("contact", s.contact), conv, t.touched_at, `id:${t.id}`]);
    }
  }
  for (const s of scenarios) {
    const r = await db.query("SELECT touch_id, basis FROM public.opportunity_ad_origins WHERE opportunity_id = $1", [idOf("opp", s.opportunity.id)]);
    const row = r.rows[0];
    const got = { touch_id: row?.touch_id ? [...ids].find(([, v]) => v === row.touch_id)?.[0].replace(/^touch:[^/]*\//, "") ?? "?" : null, basis: row?.basis };
    const ok = r.rows.length === 1 && got.touch_id === s.expected.touch_id && got.basis === s.expected.basis;
    if (!ok) failures++;
    report.push({ verificação: s.name.slice(0, 90), esperado: `${s.expected.touch_id ?? "—"} / ${s.expected.basis}`, view: `${got.touch_id ?? "—"} / ${got.basis}`, resultado: ok ? "OK" : "DIVERGE" });
  }
} finally {
  await db.exec("ROLLBACK");
}
const left = await db.query("SELECT count(*) AS n FROM pg_tables WHERE tablename='lead_ad_touches'");
report.push({ verificação: "depois do ROLLBACK a tabela não existe mais", resultado: Number(left.rows[0].n) === 0 ? "OK" : "FALHOU" });
if (Number(left.rows[0].n) !== 0) failures++;

console.table(report);
console.log(failures === 0 ? `\nTudo certo: ${scenarios.length} cenários da view iguais aos da API; migração idempotente; ROLLBACK confirmado.` : `\n${failures} verificação(ões) falharam.`);
process.exit(failures === 0 ? 0 : 1);
