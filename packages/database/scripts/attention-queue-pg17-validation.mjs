// Validação ISOLADA da migração 20261117120000 e da consulta public.attention_queue_candidates em PostgreSQL 17 DESCARTÁVEL
// (embedded-postgres), com dados SINTÉTICOS. Nenhuma conexão com produção. O servidor e a pasta de dados são apagados no fim.
//
// Uso:  PG_DIR=<pasta com embedded-postgres e pg> AQ_SCALES=3000,30000 AQ_REPORT=/caminho/relatorio.json \
//         node packages/database/scripts/attention-queue-pg17-validation.mjs
//   AQ_SCALES = nº de conversas por cenário (cada escala usa um banco novo). Mensagens ≈ 40 por conversa.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const PG_DIR = process.env.PG_DIR; if (!PG_DIR) throw new Error("defina PG_DIR");
const SCALES = (process.env.AQ_SCALES ?? "3000,30000").split(",").map(Number);
const REPORT = process.env.AQ_REPORT ?? join(tmpdir(), "aq-pg17-report.json");
const PORT = Number(process.env.AQ_PORT ?? 54331);
const MIG = new URL("../../../supabase/migrations/", import.meta.url);
const OURS = "20261117120000_attention_queue.sql";
const req = createRequire(pathToFileURL(`${PG_DIR}/package.json`));
const EmbeddedPostgres = (await import(pathToFileURL(req.resolve("embedded-postgres")).href)).default;
const { Client } = req("pg");

const dataDir = mkdtempSync(join(tmpdir(), "aq-pgdata-"));
const pgLog = [];
const server = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "descartavel", port: PORT, persistent: false, onLog: (m) => pgLog.push(String(m)), onError: (m) => pgLog.push(String(m)) });
const say = (...a) => console.log(...a);
const md5 = (s) => createHash("md5").update(s).digest("hex");
const conn = (database) => new Client({ host: "127.0.0.1", port: PORT, user: "postgres", password: "descartavel", database });
const report = { gerado_em: new Date().toISOString(), escalas: [] };

async function bootstrap(c) {
  await c.query(`
    create schema if not exists extensions; create domain extensions.vector as real[]; create domain public.vector as real[];
    create or replace function extensions.uuid_generate_v4() returns uuid language sql as $$ select gen_random_uuid() $$;
    create publication supabase_realtime; set search_path to public, extensions;
    create schema if not exists auth; create table auth.users(id uuid primary key default gen_random_uuid(), email text);
    create or replace function auth.uid() returns uuid language sql as $$ select null::uuid $$;
    create or replace function auth.role() returns text language sql as $$ select 'service_role'::text $$;
    do $r$ begin
      if not exists (select from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists (select from pg_roles where rolname='anon') then create role anon; end if;
      if not exists (select from pg_roles where rolname='service_role') then create role service_role; end if; end $r$;
    create schema if not exists storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid(), bucket_id text, name text);
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
    alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
    create schema supabase_migrations; create table supabase_migrations.schema_migrations(version text primary key, name text);`);
  const files = readdirSync(MIG).filter((f) => f.endsWith(".sql") && !f.startsWith("00001_") && f !== OURS).sort();
  const failed = [];
  for (const f of files) {
    const sql = readFileSync(new URL(f, MIG), "utf8").replace(/vector\(\d+\)/g, "real[]").replace(/create index[^;]*using (hnsw|ivfflat)[^;]*;/gi, "").replace(/CONCURRENTLY /g, "");
    try { await c.query(sql); } catch (e) { try { await c.query("ROLLBACK"); } catch { /* */ } failed.push(`${f}: ${e.message}`); }
  }
  return { aplicadas: files.length - failed.length, falhas: failed };
}

const fingerprint = async (c) => {
  const cols = (await c.query(`select md5(string_agg(c.relname||'.'||a.attname||':'||format_type(a.atttypid,a.atttypmod)||a.attnotnull::text, ',' order by c.relname, a.attnum)) m from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped where n.nspname='public' and c.relkind in ('r','p')`)).rows[0].m;
  const idx = (await c.query(`select md5(string_agg(indexdef, ',' order by indexname)) m from pg_indexes where schemaname='public'`)).rows[0].m;
  const pol = (await c.query(`select md5(coalesce(string_agg(tablename||policyname, ',' order by tablename, policyname), '')) m from pg_policies where schemaname='public'`)).rows[0].m;
  const trg = (await c.query(`select md5(coalesce(string_agg(tgrelid::regclass::text||tgname, ',' order by tgrelid::regclass::text, tgname), '')) m from pg_trigger where not tgisinternal`)).rows[0].m;
  const rows = (await c.query(`select coalesce(sum((xpath('/row/c/text()', query_to_xml('select count(*) as c from public.'||quote_ident(relname), false, true, '')))[1]::text::bigint),0) t from pg_class where relnamespace='public'::regnamespace and relkind='r'`)).rows[0].t;
  return { colunas: cols, indices: idx, policies: pol, gatilhos: trg, linhas_total: String(rows) };
};
const funcs = async (c) => (await c.query(`select p.proname, pg_get_function_identity_arguments(p.oid) args, has_function_privilege('anon', p.oid, 'EXECUTE') anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated, has_function_privilege('service_role', p.oid, 'EXECUTE') service_role from pg_proc p where p.proname='attention_queue_candidates' and pronamespace='public'::regnamespace`)).rows;

async function seed(c, N) {
  const q = (s, p) => c.query(s, p);
  const org = (await q(`insert into public.organizations(name, slug, settings) values ('Sintética','sintetica',$1) returning id`, [JSON.stringify({ lead_distribution_enabled: true })])).rows[0].id;
  const users = [];
  for (const nome of ["Marina", "Márcio"]) {
    const u = (await q("insert into auth.users(email) values ($1) returning id", [`${nome}@sintetico.test`])).rows[0].id;
    await q("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'agent')", [org, u]);
    await q("insert into public.sales_reps(organization_id,user_id,display_name,rotation_order) values ($1,$2,$3,$4)", [org, u, nome, users.length + 1]);
    users.push(u);
  }
  const agent = (await q("insert into public.agents(organization_id, name, system_prompt) values ($1,'a','p') returning id", [org])).rows[0].id;
  const inst = (await q("insert into public.evolution_instances(organization_id, instance_name, instance_id) values ($1,'i','synthetic-instance') returning id", [org])).rows[0]?.id;
  await q(`insert into public.wa_contacts(organization_id, phone, name) select $1, '5577'||lpad(g::text,9,'0'), 'Contato '||g from generate_series(1,$2) g`, [org, N]);
  // 55% com dono (50/50), 5% sem dono com takeover, 40% só IA; atividade recente concentrada (potência), até 120 dias.
  await q(`insert into public.conversations(organization_id, agent_id, evolution_instance_id, contact_id, status, is_human_takeover, assigned_to, last_message_at, created_at)
    select $1,$2,$3, w.id, case when random()<0.9 then 'open' else 'closed' end,
      (w.b >= 0.55 and w.b < 0.60), case when w.b < 0.55 then ($4::uuid[])[1 + (w.rn % 2)] end,
      now() - w.recency * interval '1 day', now() - interval '130 days'
    from (select id, row_number() over () rn, random() b, power(random(),2) * 120 as recency from public.wa_contacts where organization_id=$1) w`, [org, agent, inst, users]);
  await q(`insert into public.messages(conversation_id, organization_id, role, content, created_at)
    select c.id, c.organization_id,
      case when i = c.k then (case when random() < 0.35 then 'contact' when c.assigned_to is not null and random() < 0.5 then 'human_agent' else 'agent' end)
           when random() < 0.45 then 'contact' when c.assigned_to is not null and random() < 0.55 then 'human_agent' else 'agent' end,
      'mensagem '||i||' '||md5(random()::text),
      c.last_message_at - (c.k - i) * interval '1 hour' * (0.5 + random() * 6)
    from (select cc.*, 5 + floor(power(random(),2) * 115)::int as k from public.conversations cc where cc.organization_id=$1) c cross join lateral generate_series(1, c.k) i`, [org]);
  // ~97% das respostas humanas têm envio aceito pela Evolution (evolution_message_id); ~3% ficaram pendentes/sem confirmação
  await q("update public.messages set evolution_message_id = md5(id::text) where role = 'human_agent' and random() < 0.97");
  // leads pendentes sem 1º atendimento (≈1% das conversas com dono) + aceitos (ruído)
  await q(`with pick as (select c.id conv, c.contact_id, c.assigned_to, c.last_message_at, row_number() over () rn from public.conversations c where c.organization_id=$1 and c.assigned_to is not null),
    h as (insert into public.handoff_events(organization_id, conversation_id, trigger_type, criado_por, handed_at) select $1, conv, 'request_human', 'ia', last_message_at - interval '2 hours' from pick returning id, conversation_id)
    insert into public.lead_assignments(organization_id, chain_id, handoff_event_id, contact_id, conversation_id, rep_id, reason, status, assigned_at, handoff_at, strategy_version, accepted_at, first_human_message_at, accepted_via)
    select $1, gen_random_uuid(), h.id, p.contact_id, p.conv, (select r.id from public.sales_reps r where r.user_id=p.assigned_to), 'round_robin',
      case when p.rn % 50 = 0 then 'pending' else 'accepted' end, p.last_message_at - interval '2 hours', p.last_message_at - interval '2 hours', 'x',
      case when p.rn % 50 = 0 then null else p.last_message_at - interval '1 hour' end, case when p.rn % 50 = 0 then null else p.last_message_at - interval '1 hour' end,
      case when p.rn % 50 = 0 then null when p.rn % 3 = 0 then 'first_message' else 'button' end
    from pick p join h on h.conversation_id=p.conv`, [org]);
  await q("analyze"); await q("vacuum analyze public.messages");
  const cont = (await q(`select (select count(*) from public.conversations) conversas, (select count(*) from public.conversations where last_message_at >= now()-interval '30 days') conversas_30d,
    (select count(*) from public.messages) mensagens, (select count(*) from public.messages where created_at >= now()-interval '7 days') mensagens_7d,
    (select count(*) from public.lead_assignments where status='pending') leads_pendentes`)).rows[0];
  return { org, users, cont };
}

const statsOf = async (c) => {
  await c.query("select pg_stat_force_next_flush()"); await c.query("select pg_sleep(0.05)");
  const t = (await c.query(`select relname, seq_scan, seq_tup_read, idx_scan, idx_tup_fetch from pg_stat_user_tables where relname in ('messages','conversations','lead_assignments','wa_contacts','sales_reps','handoff_events','organizations')`)).rows;
  const i = (await c.query(`select relname, indexrelname, idx_scan, idx_tup_read, idx_tup_fetch from pg_stat_user_indexes where relname in ('messages','conversations','lead_assignments','wa_contacts','sales_reps','handoff_events','organizations')`)).rows;
  return { t, i };
};
const delta = (a, b) => {
  const tab = {}; for (const r of b.t) { const p = a.t.find((x) => x.relname === r.relname); const d = { seq_scan: +r.seq_scan - +p.seq_scan, seq_linhas_lidas: +r.seq_tup_read - +p.seq_tup_read, idx_scans: +r.idx_scan - +p.idx_scan, linhas_lidas_via_indice: +r.idx_tup_fetch - +p.idx_tup_fetch }; if (d.seq_scan || d.idx_scans || d.seq_linhas_lidas || d.linhas_lidas_via_indice) tab[r.relname] = d; }
  const ix = {}; for (const r of b.i) { const p = a.i.find((x) => x.indexrelname === r.indexrelname); const d = { scans: +r.idx_scan - +p.idx_scan, entradas_lidas: +r.idx_tup_read - +p.idx_tup_read }; if (d.scans) ix[`${r.relname}.${r.indexrelname}`] = d; }
  return { tabelas: tab, indices: ix };
};
const walk = (node, out = []) => { out.push(node); for (const ch of node.Plans ?? []) walk(ch, out); return out; };
const plansFromLog = (from) => {
  const text = pgLog.slice(from).join("\n"); const plans = []; let pos = 0;
  while ((pos = text.indexOf("plan:", pos)) >= 0) {
    const s = text.indexOf("{", pos); if (s < 0) break; let depth = 0, e = s;
    for (; e < text.length; e++) { if (text[e] === "{") depth++; else if (text[e] === "}") { depth--; if (depth === 0) break; } }
    try { plans.push(JSON.parse(text.slice(s, e + 1))); } catch { /* ignora */ } pos = e;
  }
  return plans;
};
const summarizePlan = (plan) => {
  const nodes = walk(plan.Plan); const byIdx = {}; const nosMessages = nodes.filter((n) => String(n["Index Name"] ?? "").includes("messages") || n["Relation Name"] === "messages" || n.Alias === "m").map((n) => ({ tipo: n["Node Type"], tabela: n["Relation Name"] ?? n.Alias, indice: n["Index Name"], cond_indice: n["Index Cond"], filtro: n.Filter, linhas: n["Actual Rows"], removidas_pelo_filtro: n["Rows Removed by Filter"], loops: n["Actual Loops"] })); let msgSeq = 0; const msgRead = { linhas_lidas_tabela_messages: 0 };
  for (const n of nodes) {
    if (n["Index Name"]) { const k = `${n["Relation Name"] ?? n.Alias ?? "?"}.${n["Index Name"]}`; byIdx[k] = (byIdx[k] ?? 0) + (n["Actual Loops"] ?? 1); }
    if ((n["Relation Name"] ?? n.Alias) === "messages" || n.Alias === "m") {
      const loops = n["Actual Loops"] ?? 1; const read = ((n["Actual Rows"] ?? 0) + (n["Rows Removed by Filter"] ?? 0)) * loops;
      msgRead.linhas_lidas_tabela_messages += read; if (n["Node Type"] === "Seq Scan") msgSeq++;
    }
  }
  return { duracao_ms: plan["Execution Time"] ?? plan.Plan["Actual Total Time"], indices_usados: byIdx, seq_scans_em_messages: msgSeq, ...msgRead, nos_de_messages: nosMessages, buffers: { hit: plan.Plan["Shared Hit Blocks"], read: plan.Plan["Shared Read Blocks"] } };
};

async function runScale(N) {
  const dbname = `aq_${N}_${Date.now()}`;
  const admin = conn("postgres"); await admin.connect(); await admin.query(`create database ${dbname}`); await admin.end();
  const c = conn(dbname); c.on("error", () => {}); await c.connect();
  const out = { conversas_alvo: N, banco: dbname };
  say(`\n=== escala ${N} conversas ===`);
  out.esquema = await bootstrap(c); say("esquema:", out.esquema.aplicadas, "migrações aplicadas;", out.esquema.falhas.length, "falhas", out.esquema.falhas.slice(0, 3));
  // -------- migração: aplicação, reaplicação, privilégios, rollback e esquema idêntico --------
  const antes = await fingerprint(c);
  const sqlOurs = readFileSync(new URL(OURS, MIG), "utf8");
  await c.query(sqlOurs); const f1 = await funcs(c);
  await c.query(sqlOurs); const f2 = await funcs(c); // idempotente
  const depois = await fingerprint(c);
  await c.query("drop function if exists public.attention_queue_candidates(uuid, timestamptz, integer, uuid)"); const f3 = await funcs(c);
  const aposRollback = await fingerprint(c);
  await c.query(sqlOurs);
  out.migracao = { aplicada: f1.length === 1, reaplicacao_idempotente: f2.length === 1, privilegios: f1[0], rollback_remove_funcao: f3.length === 0,
    esquema_identico_antes_depois: JSON.stringify(antes) === JSON.stringify(depois), esquema_identico_apos_rollback: JSON.stringify(antes) === JSON.stringify(aposRollback), impressao_antes: antes, impressao_depois: depois };
  say("migração:", JSON.stringify({ ...out.migracao, impressao_antes: undefined, impressao_depois: undefined }));
  // -------- dados sintéticos --------
  const t0 = Date.now(); const s = await seed(c, N); out.dados = { ...Object.fromEntries(Object.entries(s.cont).map(([k, v]) => [k, +v])), segundos_para_gerar: Math.round((Date.now() - t0) / 1000) }; say("dados:", JSON.stringify(out.dados));
  const [marina, marcio] = s.users;
  await c.query("load 'auto_explain'");
  await c.query("set auto_explain.log_min_duration = 0; set auto_explain.log_nested_statements = on; set auto_explain.log_analyze = on; set auto_explain.log_buffers = on; set auto_explain.log_format = json; set auto_explain.log_timing = on");
  const since = "now() - interval '30 days'";
  const call = (owner) => `select * from public.attention_queue_candidates('${s.org}', ${since}, 200, ${owner ? `'${owner}'` : "null"})`;
  out.cenarios = {};
  for (const [nome, owner] of [["gestor", null], ["vendedor_Marina", marina], ["vendedor_Marcio", marcio]]) {
    await c.query("select pg_stat_reset()");
    await c.query("checkpoint");
    const a = await statsOf(c); const logFrom = pgLog.length;
    const r = await c.query(call(owner)); const b = await statsOf(c);
    const plans = plansFromLog(logFrom).filter((p) => /attention_queue_candidates|messages/.test(JSON.stringify(p["Query Text"] ?? "")) || true);
    // tempo: mediana de 5 execuções (sem auto_explain para não distorcer)
    await c.query("set auto_explain.log_min_duration = -1"); const ts = [];
    for (let k = 0; k < 5; k++) { const t = process.hrtime.bigint(); await c.query(call(owner)); ts.push(Number(process.hrtime.bigint() - t) / 1e6); } ts.sort((x, y) => x - y);
    await c.query("set auto_explain.log_min_duration = 0");
    const awaiting = r.rows.filter((x) => x.kind === "awaiting").length, leads = r.rows.filter((x) => x.kind === "new_lead").length;
    out.cenarios[nome] = { linhas_devolvidas: r.rows.length, aguardando: awaiting, leads, mediana_ms_5_execucoes: +ts[2].toFixed(1), leituras_pelas_estatisticas: delta(a, b), planos_capturados: plans.length, planos: plans.map(summarizePlan) };
    say(`cenário ${nome}:`, JSON.stringify({ ...out.cenarios[nome], planos: undefined, leituras_pelas_estatisticas: out.cenarios[nome].leituras_pelas_estatisticas }));
  }
  // -------- o que o /dashboard/summary já lê ao abrir a tela (mesmas consultas, PostgREST com max-rows padrão 1000) --------
  const summary = [
    ["getConversationStatusesByOrganization", `select status from public.conversations where organization_id='${s.org}'`],
    ["getMessagesForDashboard(7d, max-rows 1000)", `select conversation_id, role, created_at from public.messages where organization_id='${s.org}' and created_at >= now()-interval '7 days' order by conversation_id, created_at limit 1000`],
    ["getMessagesForDashboard(7d, SEM limite)", `select conversation_id, role, created_at from public.messages where organization_id='${s.org}' and created_at >= now()-interval '7 days' order by conversation_id, created_at`],
    ["getHumanTakeoverConversations", `select c.id, c.human_takeover_at, w.name, w.phone from public.conversations c left join public.wa_contacts w on w.id=c.contact_id where c.organization_id='${s.org}' and c.is_human_takeover and c.status not in ('resolved','closed')`],
    ["getPendingHandoffs", `select h.*, c.id, c.contact_id, w.name, w.phone from public.handoff_events h left join public.conversations c on c.id=h.conversation_id left join public.wa_contacts w on w.id=c.contact_id where h.organization_id='${s.org}' and h.trigger_type='request_human' and h.first_human_reply_at is null order by h.handed_at`],
    ["getOrganizationById", `select * from public.organizations where id='${s.org}'`],
  ];
  await c.query("set auto_explain.log_min_duration = -1");
  const sumOut = {};
  for (const [nome, sql] of summary) {
    await c.query("select pg_stat_reset()"); const a = await statsOf(c); const r = await c.query(sql); const b = await statsOf(c);
    sumOut[nome] = { linhas_devolvidas: r.rowCount, leituras: delta(a, b) };
  }
  // getRecentMessages(1) para cada conversa em takeover (1 consulta por conversa)
  const takeovers = (await c.query(`select id from public.conversations where organization_id='${s.org}' and is_human_takeover and status not in ('resolved','closed')`)).rows;
  await c.query("select pg_stat_reset()"); const a2 = await statsOf(c);
  for (const t of takeovers) await c.query("select * from public.messages where conversation_id=$1 order by created_at desc limit 1", [t.id]);
  sumOut[`getRecentMessages(1) x ${takeovers.length} conversas em takeover`] = { leituras: delta(a2, await statsOf(c)) };
  out.summary_ja_faz = sumOut; say("summary:", Object.keys(sumOut).join(" | "));
  // -------- correção: oráculo por força bruta (janelas, varrendo tudo) x a função --------
  const oracle = (await c.query(`
    with m as (select conversation_id, role, created_at, (metadata->>'send_failed_at') failed, evolution_message_id evo from public.messages where created_at >= now() - interval '30 days'),
    lh as (select conversation_id, max(created_at) filter (where role='human_agent' and evo is not null and coalesce(failed,'')='') h from m group by 1),
    w as (select m.conversation_id, min(m.created_at) waiting_since from m left join lh using (conversation_id) where m.role='contact' and (lh.h is null or m.created_at > lh.h) group by 1)
    select c.id from public.conversations c join w on w.conversation_id=c.id where c.status in ('open','waiting') and c.last_message_at >= now()-interval '30 days' and (c.assigned_to is not null or c.is_human_takeover) order by 1`)).rows.map((x) => x.id);
  const got = (await c.query(`select conversation_id from public.attention_queue_candidates('${s.org}', now()-interval '30 days', 100000, null) where kind='awaiting' order by 1`)).rows.map((x) => x.conversation_id);
  // leads: oráculo por força bruta (pendente/exceção/aceito pela mensagem, na janela, sem resposta humana CONFIRMADA depois da atribuição)
  const oracleLeads = (await c.query(`select la.conversation_id from public.lead_assignments la
    where la.organization_id='${s.org}' and la.handoff_at >= now()-interval '30 days'
      and (la.status='pending' or (la.status='exception' and la.resolved_at is null) or (la.status='accepted' and la.accepted_via in ('first_message','phone_echo')))
      and not exists (select 1 from public.messages m where m.conversation_id=la.conversation_id and m.role='human_agent' and m.created_at >= la.assigned_at and m.evolution_message_id is not null and coalesce(m.metadata->>'send_failed_at','')='')
    order by 1`)).rows.map((x) => x.conversation_id);
  const gotLeads = (await c.query(`select conversation_id from public.attention_queue_candidates('${s.org}', now()-interval '30 days', 100000, null) where kind='new_lead' order by 1`)).rows.map((x) => x.conversation_id);
  out.correcao = { oraculo_forca_bruta: oracle.length, funcao: got.length, conjuntos_iguais: JSON.stringify(oracle) === JSON.stringify(got), leads_oraculo: oracleLeads.length, leads_funcao: gotLeads.length, leads_iguais: JSON.stringify(oracleLeads) === JSON.stringify(gotLeads) };
  say("correção (oráculo x função):", JSON.stringify(out.correcao));
  // -------- EXPERIMENTO OPCIONAL (só no banco descartável): índice (conversation_id, role, created_at) para achar a última resposta humana sem ler a conversa inteira --------
  await c.query("set auto_explain.log_min_duration = -1");
  await c.query("create index idx_messages_conv_role_created_exp on public.messages (conversation_id, role, created_at)"); await c.query("analyze public.messages");
  out.experimento_indice_opcional = { indice: "messages(conversation_id, role, created_at)", cenarios: {} };
  for (const [nome, owner] of [["gestor", null], ["vendedor_Marina", marina]]) {
    await c.query("select pg_stat_reset()"); const a = await statsOf(c); const r = await c.query(call(owner)); const b = await statsOf(c);
    const ts = []; for (let k = 0; k < 5; k++) { const t = process.hrtime.bigint(); await c.query(call(owner)); ts.push(Number(process.hrtime.bigint() - t) / 1e6); } ts.sort((x, y) => x - y);
    const d = delta(a, b); out.experimento_indice_opcional.cenarios[nome] = { linhas_devolvidas: r.rows.length, mediana_ms_5_execucoes: +ts[2].toFixed(1), messages: d.tabelas.messages, indices_messages: Object.fromEntries(Object.entries(d.indices).filter(([k]) => k.startsWith("messages."))) };
  }
  say("experimento índice opcional:", JSON.stringify(out.experimento_indice_opcional));
  await c.query("drop index public.idx_messages_conv_role_created_exp");
  await c.end();
  return out;
}

// execução (no fim do arquivo para que as funções/consts acima já existam)
try {
  await server.initialise(); await server.start();
  const admin = conn("postgres"); await admin.connect();
  report.versao = (await admin.query("select version() as v")).rows[0].v; say("VERSÃO:", report.versao);
  await admin.end();
  for (const n of SCALES) { try { report.escalas.push(await runScale(n)); } catch (e) { console.error("ERRO NA ESCALA", n, "->", e.message, e.where ?? ""); throw e; } }
  writeFileSync(REPORT, JSON.stringify(report, null, 2)); say("RELATÓRIO:", REPORT);
} finally {
  try { await server.stop(); } catch { /* já parado */ }
  rmSync(dataDir, { recursive: true, force: true });
  say("servidor temporário encerrado e pasta de dados apagada:", dataDir);
}
