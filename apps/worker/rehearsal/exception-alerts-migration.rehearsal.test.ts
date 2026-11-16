// ENSAIO ISOLADO (não é produção): banco descartável (PGlite) com o esquema ANTERIOR + migração 20261116120000 aplicada,
// worker real (runExceptionAlertsOnce) com as consultas reais do pacote database, provedor de push SIMULADO (nenhum envio real).
// Roda com: npx vitest run rehearsal/exception-alerts-migration.rehearsal.test.ts   (evidências saem em console.log, prefixo "EVID")
import { beforeEach, describe, expect, it } from "vitest";
import {
  claimAlertSlot, listCurrentMemberIds, listRecordedAlertSlots, listSalesReps, loadAlertReadinessRecipients, loadTriageItems, markAlertSending, releaseAlertSlot,
  releaseStaleAlertClaims, claimAlertSlot as claim, finishAlertSlot,
} from "../../../packages/database/src/index.js";
import { setupHandoffDb, seedLead, seedWorld, ALL_ON, NEW_MIGRATIONS, M, type Db } from "../../../packages/database/src/sql/handoff-fixture.js";
import { postgrestLite } from "../../../packages/database/src/sql/real-schema-db.js";
import { readFileSync } from "node:fs";
import { STALE_CLAIM_MS, pushResultToOutcome, runExceptionAlertsOnce, type ExceptionAlertDeps } from "../src/workers/exception-alerts.js";
import { sendPushToUser } from "../../../packages/database/src/index.js";

void claim; void claimAlertSlot; void listRecordedAlertSlots; void finishAlertSlot; void releaseAlertSlot; void markAlertSending;
const MIGRATION = "20261116120000_exception_triage_alerts.sql";
const evid = (title: string, data: unknown) => console.log(`EVID ${title}\n${typeof data === "string" ? data : JSON.stringify(data, null, 1)}`);

let db: Db; let q: (sql: string, p?: unknown[]) => Promise<any[]>; let client: any;

/** Esquema ANTERIOR (sem as tabelas novas) para provar o estado de partida. */
async function previousSchema() {
  ({ db, q } = await setupHandoffDb({ apply: [...NEW_MIGRATIONS] }));
  await q("alter table public.conversations add column if not exists status text");
  await q("alter table public.wa_contacts add column if not exists name text");
  await q("create table if not exists public.push_subscriptions (id uuid primary key default gen_random_uuid(), organization_id uuid, user_id uuid, endpoint text, p256dh text default 'k', auth text default 'a')");
  client = postgrestLite(db as never);
  client.rpc = async (name: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    try { const res = await db.query<any>(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map(k => args[k])); return { data: res.rows[0].r, error: null }; }
    catch (e: any) { return { data: null, error: { code: e.code, message: e.message } }; }
  };
}
const applyMigration = () => db.exec(readFileSync(M(MIGRATION), "utf8"));

describe("A) migração em banco descartável com o esquema anterior", () => {
  beforeEach(previousSchema);
  it("antes: objetos não existem; depois: coluna, índice único, RLS e privilégios corretos; reaplicar é idempotente", async () => {
    expect((await q("select count(*)::int n from pg_class where relname like 'exception_%' and relkind='r'"))[0].n).toBe(0);
    await applyMigration();
    const col = await q("select column_name, data_type, is_nullable from information_schema.columns where table_name='exception_alert_ledger' and column_name='send_started_at'");
    const idx = await q("select indexdef from pg_indexes where indexname='exception_alert_ledger_unique'");
    const rls = await q("select relname, relrowsecurity from pg_class where relname in ('exception_events','exception_alert_ledger','exception_alert_recipients') order by relname");
    const privs: Record<string, unknown> = {};
    for (const role of ["anon", "authenticated"]) for (const t of ["exception_events", "exception_alert_ledger", "exception_alert_recipients"])
      for (const p of ["select", "insert", "update", "delete"]) privs[`${role}.${t}.${p}`] = (await q(`select has_table_privilege('${role}','public.${t}','${p}') as ok`))[0].ok;
    const svc = (await q("select has_table_privilege('service_role','public.exception_alert_ledger','insert') i, has_table_privilege('service_role','public.exception_alert_ledger','update') u"))[0];
    const fn = await q("select has_function_privilege('anon','public.record_exception_event(uuid,uuid,text,uuid,text,uuid)','execute') a, has_function_privilege('authenticated','public.record_exception_event(uuid,uuid,text,uuid,text,uuid)','execute') b, has_function_privilege('service_role','public.record_exception_event(uuid,uuid,text,uuid,text,uuid)','execute') s");
    const policies = (await q("select count(*)::int n from pg_policies where tablename like 'exception_%'"))[0].n;
    await applyMigration(); // reaplicação
    const idx2 = await q("select indexdef from pg_indexes where indexname='exception_alert_ledger_unique'");
    evid("A.coluna", col); evid("A.indice", idx[0].indexdef); evid("A.rls", rls); evid("A.service_role", svc); evid("A.funcao(anon,authenticated,service)", fn); evid("A.policies", policies);
    expect(col).toEqual([{ column_name: "send_started_at", data_type: "timestamp with time zone", is_nullable: "YES" }]);
    expect(idx[0].indexdef).toMatch(/UNIQUE INDEX.*\(assignment_id, stage, channel, COALESCE\(recipient_user_id/);
    expect(rls.every((r: any) => r.relrowsecurity)).toBe(true);
    expect(Object.values(privs).every(v => v === false)).toBe(true);
    expect(svc).toEqual({ i: true, u: true });
    expect(fn[0]).toEqual({ a: false, b: false, s: true });
    expect(policies).toBe(0);
    expect(idx2).toEqual(idx);
  });
  it("o índice único barra duplicata por (exceção, estágio, canal, destinatário) e permite destinatários/canais diferentes; null conta como um só", async () => {
    await applyMigration();
    const w = await seedWorld(db, ALL_ON, [["Marina", 1], ["Márcio", 2]]);
    const a = "11111111-1111-4111-8111-111111111111";
    const ins = (stage: number, channel: string, rec: string | null) => q("insert into public.exception_alert_ledger(organization_id,assignment_id,stage,channel,recipient_user_id,mode) values ($1,$2,$3,$4,$5,'on')", [w.org, a, stage, channel, rec]);
    await ins(0, "push", w.def);
    await expect(ins(0, "push", w.def)).rejects.toMatchObject({ code: "23505" });
    await ins(0, "push", w.reps["Marina"].userId); await ins(0, "shadow", w.def); await ins(15, "push", w.def);
    await ins(0, "skipped", null);
    await expect(ins(0, "skipped", null)).rejects.toMatchObject({ code: "23505" });
    evid("A.unicidade", "duplicata (mesma exceção/estágio/canal/destinatário) => 23505; destinatário, canal e estágio distintos coexistem; recipient NULL também é único");
  });
});

// ---------- cenário com worker real ----------
type Provider = {
  mode: "ok" | "down" | "accept_then_lose_response" | "partial_accept_one_device";
  delivered: Array<{ user: string; stage: string; tag: string }>; attempts: number;
};
const VAPID = { VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv", VAPID_SUBJECT: "mailto:ensaio@example.test" };

async function world() {
  await previousSchema(); await applyMigration();
  const w = await seedWorld(db, ALL_ON, [["Marina", 1], ["Márcio", 2]]);
  for (const r of Object.values(w.reps)) await q("insert into public.organization_members(organization_id,user_id,role) values ($1,$2,'agent') on conflict do nothing", [w.org, r.userId]);
  await q("insert into public.exception_alert_recipients(organization_id,user_id) values ($1,$2)", [w.org, w.def]);
  for (const u of [w.def, w.reps["Marina"].userId, w.reps["Márcio"].userId]) { await q("insert into public.push_subscriptions(organization_id,user_id,endpoint) values ($1,$2,$3)", [w.org, u, `https://push.test/${u}`]); }
  const h = await seedLead(db, w.org, { handedAt: new Date(Date.now() - 130 * 60_000).toISOString() });
  const iso = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
  // exceção REAL criada em T0 (11:00 BRT) pelo caminho oficial; handoff original 130 min antes (nada de UPDATE em lead_assignments, que é protegida)
  const first = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, iso(-120)]))[0].id as string;
  const second = (await q("select public.redistribute_assignment($1,$2) as id", [first, iso(-60)]))[0].id as string;
  const exception = (await q("select public.redistribute_assignment($1,$2) as id", [second, iso(0)]))[0].id as string;
  const setSettings = (patch: Record<string, unknown>) => q("update public.organizations set settings = settings || $2::jsonb where id=$1", [w.org, JSON.stringify(patch)]);
  // assigned_at da exceção é o now() do banco (as funções SQL ignoram o relógio simulado): o tempo simulado parte DELE.
  const T = new Date((await q("select assigned_at from public.lead_assignments where id=$1", [exception]))[0].assigned_at);
  const at = (min: number) => new Date(T.getTime() + min * 60_000);
  const allDay = { windows: [{ start: "00:00", end: "23:59" }] };
  const day = allDay.windows;
  await setSettings({
    exception_alerts_activated_at: new Date(T.getTime() - 3600_000).toISOString(), exception_alerts_mode: "off",
    business_calendar: { timeZone: "UTC", weekly: { sun: day, mon: day, tue: day, wed: day, thu: day, fri: day, sat: day } }, // expediente 24h: ensaio independe da hora do dia
  });
  const names: Record<string, string> = { [w.def]: "gestor", [w.reps["Marina"].userId]: "marina", [w.reps["Márcio"].userId]: "marcio" };
  const provider: Provider = { mode: "ok", delivered: [], attempts: 0 };
  const logs: string[] = [];
  const userByEndpoint = new Map<string, string>();
  let nowRef = T; let failFinish = 0;
  const readMode = async () => (await q("select settings->>'exception_alerts_mode' m from public.organizations where id=$1", [w.org]))[0].m;
  const deps: ExceptionAlertDeps = {
    now: () => nowRef,
    listOrganizations: async () => await q("select id, settings from public.organizations where id=$1", [w.org]),
    currentMode: async () => (await readMode()) ?? "off",
    loadItems: (org, cal, now) => loadTriageItems(client, org, cal, now),
    recordedSlots: ids => listRecordedAlertSlots(client, ids),
    managerIds: async org => (await loadAlertReadinessRecipients(client, org)).filter(r => r.memberRole === "owner" || r.memberRole === "admin").map(r => r.userId),
    repUserIds: async org => [...(await listCurrentMemberIds(client, org, (await listSalesReps(client, org)).filter(r => r.availability !== "out").map(r => r.user_id)))],
    readinessFacts: async org => ({ pushConfigured: true, recipients: await loadAlertReadinessRecipients(client, org) }),
    claim: c => claimAlertSlot(client, c),
    markSending: id => markAlertSending(client, id),
    finish: async (id, status, detail) => { if (failFinish > 0) { failFinish--; throw new Error("db indisponível (simulado)"); } await finishAlertSlot(client, id, status, detail); },
    release: id => releaseAlertSlot(client, id),
    releaseStale: () => releaseStaleAlertClaims(client, STALE_CLAIM_MS),
    // Caminho REAL: sendPushToUser (classificação de erros do web-push) + a mesma tradução em desfecho que o worker de produção usa.
    sendPush: async (orgId, user, message, tag) => {
      let r;
      try {
        r = await sendPushToUser(client, user, { title: message.title, body: message.body, url: message.url, tag }, {
          organizationId: orgId, env: VAPID,
          send: async (sub: { endpoint: string }) => {
            provider.attempts++;
            const owner = names[sub.endpoint.replace("https://push.test/", "").replace(/\/d2$/, "")] ?? sub.endpoint;
            const second = sub.endpoint.endsWith("/d2");
            const deliver = () => provider.delivered.push({ user: owner, stage: message.title, tag });
            if (provider.mode === "down") throw Object.assign(new Error("Received unexpected response code"), { name: "WebPushError", statusCode: 400 });
            if (provider.mode === "accept_then_lose_response") { deliver(); throw new Error("Socket timeout"); }
            if (provider.mode === "partial_accept_one_device") { if (!second) { deliver(); return; } throw new Error("Socket timeout"); }
            deliver();
          },
        });
      } catch { return "failed"; }
      return pushResultToOutcome(r);
    },
    sleep: async () => {},
    log: { info: (...a) => logs.push(`INFO ${a.join(" ")}`), warn: (...a) => logs.push(`WARN ${a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}`), error: (...a) => logs.push(`ERROR ${a.join(" ")}`) },
  };
  const ledger = async () => (await q("select stage, channel, mode, status, recipient_user_id r, send_started_at is not null as started, detail->>'reason' as reason from public.exception_alert_ledger order by id"))
    .map((r: any) => `${r.stage}|${r.channel}|${r.mode}|${r.status}|${names[r.r] ?? r.r ?? "-"}|started=${r.started}${r.reason ? `|${r.reason}` : ""}`);
  const stageOf = (title: string) => (/CRÍTICO/.test(title) ? 60 : /Escalonamento/.test(title) ? 30 : /Cobrança/.test(title) ? 15 : 0);
  const delivered = () => provider.delivered.map(d => `${d.user}:${stageOf(d.stage)}`);
  return { userByEndpoint, at, w, deps, provider, logs, ledger, delivered, setSettings, setNow: (d: Date) => { nowRef = d; }, failFinishTimes: (n: number) => { failFinish = n; }, names, exception };
}

describe("B) shadow → on → shadow → on com push simulado", () => {
  it("cada destinatário recebe só o estágio devido; voltar para on não repete envio já registrado", async () => {
    const x = await world();
    const run = async (label: string, mode: string, minute: number) => {
      await x.setSettings({ exception_alerts_mode: mode }); x.setNow(x.at(minute));
      const s = await runExceptionAlertsOnce(x.deps);
      evid(`B.${label} (modo=${mode}, T+${minute}min)`, { resumo: s, entregues_acumulado: x.delivered(), ledger: await x.ledger() });
      return s;
    };
    const s1 = await run("1 shadow", "shadow", 0);
    expect(s1).toMatchObject({ shadowed: 3, sent: 0 }); expect(x.delivered()).toEqual([]);
    const s2 = await run("2 on", "on", 0);
    expect(s2.sent).toBe(3); expect(x.delivered().sort()).toEqual(["gestor:0", "marcio:0", "marina:0"]); // sombra NÃO suprimiu
    const s3 = await run("3 shadow (15 min depois)", "shadow", 15);
    expect(s3).toMatchObject({ shadowed: 3, sent: 0 }); expect(x.delivered()).toHaveLength(3);
    const s4 = await run("4 on", "on", 15);
    expect(s4.sent).toBe(3); expect(x.delivered().sort()).toEqual(["gestor:0", "gestor:15", "marcio:0", "marcio:15", "marina:0", "marina:15"]);
    const s5 = await run("5 on de novo (mesmo instante)", "on", 15);
    expect(s5.sent).toBe(0); expect(x.delivered()).toHaveLength(6); // nada repetido
    const s6 = await run("6 on (60 min): crítico só ao gestor, vendedores recebem 30", "on", 60);
    expect(x.delivered().slice(6).sort()).toEqual(["gestor:60", "marcio:30", "marina:30"]);
    expect(s6.sent).toBe(3);
    // vendedor nunca recebeu o crítico; ninguém recebeu o mesmo estágio duas vezes
    expect(new Set(x.delivered()).size).toBe(x.delivered().length);
    expect(x.delivered().filter(d => d.endsWith(":60")).every(d => d.startsWith("gestor"))).toBe(true);
  });
  it("recuperação de reservas: falha geral do provedor solta a reserva e o ciclo seguinte envia uma vez; reserva antiga sem marca é solta e reenviada", async () => {
    const x = await world();
    await x.setSettings({ exception_alerts_mode: "on" }); x.setNow(x.at(0));
    x.provider.mode = "down";
    const s1 = await runExceptionAlertsOnce(x.deps);
    evid("B.recuperação 1 (provedor fora)", { resumo: s1, ledger: await x.ledger(), entregues: x.delivered() });
    expect(s1.sent).toBe(0); expect(await x.ledger()).toEqual([]);
    x.provider.mode = "ok";
    const s2 = await runExceptionAlertsOnce(x.deps);
    expect(s2.sent).toBe(3); expect(x.delivered()).toHaveLength(3);
    // reserva órfã SEM send_started_at (processo caiu antes de marcar): vira solta após 5 min e é reenviada uma única vez
    await q("delete from public.exception_alert_ledger"); x.provider.delivered.length = 0;
    await claimAlertSlot(client, { organizationId: x.w.org, assignmentId: x.exception, stage: 0, channel: "push", recipientUserId: x.w.def, mode: "on" });
    await q("update public.exception_alert_ledger set created_at = now() - interval '10 minutes'");
    const s3 = await runExceptionAlertsOnce(x.deps);
    evid("B.recuperação 2 (reserva órfã sem marca)", { resumo: s3, ledger: await x.ledger(), entregues: x.delivered() });
    expect(s3.released).toBe(1); expect(x.delivered().sort()).toEqual(["gestor:0", "marcio:0", "marina:0"]);
    await runExceptionAlertsOnce(x.deps); expect(x.delivered()).toHaveLength(3);
  });
});

describe("C) casos ambíguos", () => {
  it("C1 provedor ACEITA o push e a resposta se perde (timeout): NÃO há segunda tentativa para o mesmo destinatário e estágio", async () => {
    const x = await world();
    await x.setSettings({ exception_alerts_mode: "on" }); x.setNow(x.at(0));
    x.provider.mode = "accept_then_lose_response";
    const s1 = await runExceptionAlertsOnce(x.deps);
    const afterCycle1 = { resumo: s1, ledger: await x.ledger(), entregues_pelo_provedor: x.delivered(), tentativas_no_provedor: x.provider.attempts, logs: [...x.logs] };
    x.provider.mode = "ok"; // provedor volta ao normal: se houvesse reenvio, aconteceria agora
    const s2 = await runExceptionAlertsOnce(x.deps);
    const s3 = await runExceptionAlertsOnce(x.deps);
    evid("C1 ciclo 1 (aceitou, resposta perdida)", afterCycle1);
    evid("C1 ciclos 2 e 3 (provedor normal)", { ciclo2: s2, ciclo3: s3, ledger: await x.ledger(), entregues_pelo_provedor_acumulado: x.delivered(), tentativas_no_provedor: x.provider.attempts });
    expect(afterCycle1.ledger.every(l => l.includes("skipped") && l.includes("unconfirmed_send"))).toBe(true);
    expect(s1.unconfirmed).toBe(3);
    expect(afterCycle1.logs.filter(l => l.startsWith("WARN") && /DESCONHECIDO/.test(l))).toHaveLength(3);
    expect(x.provider.delivered).toHaveLength(3); // exatamente UMA entrega por destinatário (a do ciclo 1)
    expect(x.provider.attempts).toBe(3);          // nenhuma tentativa nos ciclos 2 e 3
    expect(s2.sent + s3.sent).toBe(0);
  });
  it("C1c destinatário com 2 aparelhos: um aceita e o outro dá timeout => conta como enviado, sem reenvio", async () => {
    const x = await world();
    for (const u of [x.w.def, x.w.reps["Marina"].userId, x.w.reps["Márcio"].userId]) await q("insert into public.push_subscriptions(organization_id,user_id,endpoint) values ($1,$2,$3)", [x.w.org, u, `https://push.test/${u}/d2`]);
    await x.setSettings({ exception_alerts_mode: "on" }); x.setNow(x.at(0));
    x.provider.mode = "partial_accept_one_device";
    const s1 = await runExceptionAlertsOnce(x.deps);
    x.provider.mode = "ok";
    const s2 = await runExceptionAlertsOnce(x.deps);
    evid("C1c (2 aparelhos, 1 aceito + 1 timeout)", { ciclo1: s1, ciclo2: s2, ledger: await x.ledger(), entregues: x.delivered(), tentativas: x.provider.attempts });
    expect(s1.sent).toBe(3); expect(s1.unconfirmed).toBe(0);
    expect(x.delivered().sort()).toEqual(["gestor:0", "marcio:0", "marina:0"]);
    expect(s2.sent).toBe(0); expect(x.provider.attempts).toBe(6); // 3 destinatários x 2 aparelhos, só no ciclo 1
  });
  it("C1d falha DEFINITIVA (provedor responde 400 em todos): libera a reserva e a nova tentativa acontece", async () => {
    const x = await world();
    await x.setSettings({ exception_alerts_mode: "on" }); x.setNow(x.at(0));
    x.provider.mode = "down";
    const s1 = await runExceptionAlertsOnce(x.deps);
    const l1 = await x.ledger();
    x.provider.mode = "ok";
    const s2 = await runExceptionAlertsOnce(x.deps);
    evid("C1d (400 definitivo, depois normal)", { ciclo1: s1, ledger1: l1, ciclo2: s2, entregues: x.delivered() });
    expect(l1).toEqual([]); expect(s1.unconfirmed).toBe(0);
    expect(s2.sent).toBe(3); expect(x.delivered()).toHaveLength(3);
  });
  it("C1b provedor aceita, push saiu, mas a CONFIRMAÇÃO no banco falha (3x): não duplica; estágio vira unconfirmed_send", async () => {
    const x = await world();
    await x.setSettings({ exception_alerts_mode: "on" }); x.setNow(x.at(0));
    x.failFinishTimes(999);
    const s1 = await runExceptionAlertsOnce(x.deps);
    const l1 = await x.ledger();
    x.failFinishTimes(0);
    const s2 = await runExceptionAlertsOnce(x.deps); // dentro dos 5 min: reserva ainda ocupa o slot
    await q("update public.exception_alert_ledger set send_started_at = now() - interval '10 minutes'");
    const s3 = await runExceptionAlertsOnce(x.deps); // após 5 min: varredura converte em skipped/unconfirmed_send
    evid("C1b", { ciclo1: s1, ledger1: l1, ciclo2_dentro_de_5min: s2, ciclo3_apos_5min: s3, ledger3: await x.ledger(), entregues: x.delivered(), logs: x.logs });
    expect(x.delivered()).toHaveLength(3);
    expect(s1.unconfirmed).toBe(3); expect(s2.sent).toBe(0); expect(s3.unconfirmed).toBe(3);
    expect(x.logs.filter(l => l.startsWith("WARN") && /DESCONHECIDO/.test(l))).toHaveLength(3); // aviso por reserva convertida pela varredura
    expect((await x.ledger()).every(l => l.includes("skipped") && l.includes("unconfirmed_send"))).toBe(true);
  });
  it("C2 worker cai DEPOIS de gravar send_started_at e ANTES de chamar o push: estágio é PERDIDO (não duplica), próximo estágio segue", async () => {
    const x = await world();
    await x.setSettings({ exception_alerts_mode: "on" });
    // estado exato que o processo deixa ao morrer: reserva criada + marca gravada, nenhum push
    for (const u of [x.w.def, x.w.reps["Marina"].userId, x.w.reps["Márcio"].userId]) {
      const c = (await claimAlertSlot(client, { organizationId: x.w.org, assignmentId: x.exception, stage: 0, channel: "push", recipientUserId: u, mode: "on" }))!;
      await markAlertSending(client, c.id);
    }
    const before = await x.ledger();
    x.setNow(x.at(1));
    const s1 = await runExceptionAlertsOnce(x.deps); // reinício imediato: dentro de 5 min
    const ledgerWithin = await x.ledger();
    await q("update public.exception_alert_ledger set created_at = now() - interval '10 minutes', send_started_at = now() - interval '10 minutes'");
    x.setNow(x.at(2));
    const s2 = await runExceptionAlertsOnce(x.deps); // após 5 min
    const ledgerAfter = await x.ledger();
    const deliveredStage0 = x.delivered().filter(d => d.endsWith(":0"));
    x.setNow(x.at(15));
    const s3 = await runExceptionAlertsOnce(x.deps);
    evid("C2", { ledger_ao_cair: before, ciclo_dentro_5min: s1, ledger_dentro: ledgerWithin, ciclo_apos_5min: s2, ledger_apos: ledgerAfter, entregues_estagio0: deliveredStage0, ciclo_T15: s3, entregues_final: x.delivered(), ledger_final: await x.ledger(), logs: x.logs });
    expect(s1.sent).toBe(0); expect(ledgerWithin).toEqual(before);
    expect(s2.unconfirmed).toBe(3);
    expect(deliveredStage0).toEqual([]); // o estágio 0 NUNCA saiu: perdido, não duplicado
    // exatamente 3 envios do estágio 15, um por destinatário, e nenhum reenvio do estágio 0
    expect(x.provider.delivered).toHaveLength(3);
    expect(x.delivered().sort()).toEqual(["gestor:15", "marcio:15", "marina:15"]);
    expect(x.delivered().filter(d => d.endsWith(":0"))).toHaveLength(0);
    expect(s3.sent).toBe(3);
    const rows = await x.ledger();
    expect(rows.filter(r => r.startsWith("15|push|on|sent"))).toHaveLength(3);
    expect(rows.filter(r => r.startsWith("0|") && r.includes("unconfirmed_send"))).toHaveLength(3);
    expect(x.logs.filter(l => l.startsWith("WARN") && /DESCONHECIDO/.test(l))).toHaveLength(3); // um aviso por reserva convertida
  });
});
