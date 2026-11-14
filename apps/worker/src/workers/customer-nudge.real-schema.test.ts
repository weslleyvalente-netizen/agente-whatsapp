import { beforeAll, describe, expect, it } from "vitest";
import { closeSinglePendency, completeNudgeTasksOnSellerMessage, createTaskWithDedup, resolveUnresponsiveTasksOnReply, updateTask } from "@aula-agente/database";
import { buildRealDeps, runCustomerNudge } from "./customer-nudge.js";

// HOMOLOGAÇÃO LOCAL com o esquema REAL: as ~65 migrações de supabase/migrations aplicadas num Postgres embutido (constraints, gatilhos, jsonb,
// updated_at de verdade) e as MESMAS funções de produção (worker + queries). Só o push é simulado. Ciclo completo do Cutucar consolidado.
// Import dinâmico (caminho em variável): o tsc do worker não segue o arquivo de teste do pacote database (fora do rootDir).
const REAL_SCHEMA_DB = "../../../../packages/database/src/sql/real-schema-db.ts";
type Env = { pg: { query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }; client: any; failedMigrations: string[] };
let env: Env; let db: any; let pg: Env["pg"];

const MARINA = "11111111-1111-4111-8111-111111111111";
const MARCIO = "22222222-2222-4222-8222-222222222222";
const one = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows[0] as T;
const all = async <T = any>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows as T[];

// Sex 13/11 12:00 (BRT) o vendedor fala; terça 17/11 15:00 (BRT) já passou mais de 1 dia útil.
const SELLER_AT = "2026-11-13T15:00:00.000Z";
const NOW = new Date("2026-11-17T18:00:00.000Z");
const errs: string[] = [];
const quietLog = { info() {}, error(m: string) { errs.push(m); } };
const pushes: string[] = [];
const deps = () => buildRealDeps(db, {
  log: quietLog, canReceivePush: async () => true, claimPushDedupe: async () => true, releasePushDedupe: async () => {},
  sendPush: async (_o, userId) => { pushes.push(userId); return 1; },
});

let orgId: string; let agentId: string; let instanceId: string; let seq = 0;
async function orgSettings(patch: Record<string, unknown>) {
  await pg.query("update organizations set settings = $2::jsonb where id = $1", [orgId, JSON.stringify({ customer_nudge_enabled: true, task_consolidation_by_opportunity_enabled: true, customer_nudge_consolidated_enabled: true, ...patch })]);
}
async function seedDeal(o: { owner?: string; waitingOn?: string | null; waitingUntil?: string | null; sellerAt?: string; withTask?: boolean; stage?: string } = {}) {
  seq++;
  const contact = await one("insert into wa_contacts(organization_id, phone, name) values ($1,$2,$3) returning id", [orgId, `5562900000${String(seq).padStart(3, "0")}`, `Cliente ${seq}`]);
  const conv = await one("insert into conversations(organization_id, agent_id, evolution_instance_id, contact_id, assigned_to) values ($1,$2,$3,$4,$5) returning id", [orgId, agentId, instanceId, contact.id, o.owner ?? MARINA]);
  const opp = await one(
    "insert into opportunities(organization_id, contact_id, operation, initial_operation, stage, owner_id, waiting_on, waiting_on_until) values ($1,$2,'consortium','consortium',$3,$4,$5,$6) returning id",
    [orgId, contact.id, o.stage ?? "decision_negotiation", o.owner ?? MARINA, o.waitingOn === undefined ? "customer" : o.waitingOn, o.waitingUntil ?? null]);
  await pg.query("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'contact','Quero saber da carta', $3::timestamptz - interval '1 hour')", [conv.id, orgId, o.sellerAt ?? SELLER_AT]);
  await pg.query("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'human_agent','Segue a proposta', $3)", [conv.id, orgId, o.sellerAt ?? SELLER_AT]);
  await pg.query("update conversations set last_message_at = $2 where id = $1", [conv.id, o.sellerAt ?? SELLER_AT]);
  let taskId: string | null = null;
  if (o.withTask !== false) {
    const { task } = await createTaskWithDedup(db, {
      organization_id: orgId, contact_id: contact.id, conversation_id: conv.id, opportunity_id: opp.id, type: "return_customer", description: "Atender cliente encaminhado pela IA",
      reason: "handoff", priority: "high", due_date: "2026-11-13", created_by_type: "ai", created_by_id: null, assignee_type: "human", assignee_id: o.owner ?? MARINA,
    });
    taskId = task.id;
  }
  return { contactId: contact.id as string, convId: conv.id as string, oppId: opp.id as string, taskId };
}
const pendTypes = (t: any) => (t.consolidated_pendencies as any[]).map((p) => p.type).sort();
const getTask = (id: string) => one("select * from tasks where id = $1", [id]);

beforeAll(async () => {
  const { createRealSchemaDb } = await import(/* @vite-ignore */ REAL_SCHEMA_DB);
  env = await createRealSchemaDb(); pg = env.pg; db = env.client;
  expect(env.failedMigrations).toEqual([]); // esquema de produção aplicado por inteiro
  orgId = (await one("insert into organizations(name, slug, settings) values ('Moto e Trilha','mt','{}') returning id")).id;
  for (const [id, email] of [[MARINA, "marina@x"], [MARCIO, "marcio@x"]]) {
    await pg.query("insert into auth.users(id, email) values ($1,$2)", [id, email]);
    await pg.query("insert into organization_members(organization_id, user_id, role) values ($1,$2,'agent')", [orgId, id]);
  }
  agentId = (await one("insert into agents(organization_id, name, system_prompt) values ($1,'Mariana','x') returning id", [orgId])).id;
  instanceId = (await one("insert into evolution_instances(organization_id, instance_name, instance_id) values ($1,'weslley','abc') returning id", [orgId])).id;
}, 180_000);

describe("Cutucar consolidado — esquema real do banco", () => {
  it("criação + agrupamento: vira pendência da tarefa aberta do negócio (sem tarefa paralela), push só para o dono, toque registrado", async () => {
    await orgSettings({ push_notifications_enabled: true });
    const d = await seedDeal();
    const s = await runCustomerNudge(deps(), NOW);
    expect(errs).toEqual([]);
    expect(s).toMatchObject({ created: 1, grouped: 1, errors: 0 });
    const rows = await all("select * from tasks where opportunity_id = $1", [d.oppId]);
    expect(rows).toHaveLength(1); // nenhuma tarefa paralela
    expect(pendTypes(rows[0])).toEqual(["customer_nudge", "return_customer"]);
    expect(rows[0].assignee_id).toBe(MARINA);
    const nudge = rows[0].consolidated_pendencies.find((p: any) => p.type === "customer_nudge");
    expect(nudge.due_date).toBe("2026-11-17"); // vencimento: hoje
    expect(rows[0].due_date).toBe("2026-11-13"); // prazo da tarefa = o mais antigo (o retorno do repasse)
    const touches = await all("select note from task_events where task_id = $1 and event_type = 'customer_nudge_touch'", [rows[0].id]);
    expect(touches).toHaveLength(1);
    expect(touches[0].note).toContain(`nudge-conv:${d.convId}`);
    expect(pushes).toContain(MARINA);
  });

  it("deduplicação: nova execução e execuções simultâneas não duplicam a pendência nem a tarefa", async () => {
    const d = await seedDeal();
    await runCustomerNudge(deps(), NOW);
    const again = await runCustomerNudge(deps(), NOW);
    expect(again.created).toBe(0);
    await Promise.all([runCustomerNudge(deps(), NOW), runCustomerNudge(deps(), NOW)]);
    const rows = await all("select * from tasks where opportunity_id = $1", [d.oppId]);
    expect(rows).toHaveLength(1);
    expect(pendTypes(rows[0])).toEqual(["customer_nudge", "return_customer"]);
    const touches = await all("select 1 from task_events where task_id = $1 and event_type = 'customer_nudge_touch'", [rows[0].id]);
    expect(touches).toHaveLength(1);
  });

  it("conclusão individual: encerrar uma pendência não conclui as outras (e a última conclui a tarefa)", async () => {
    const d = await seedDeal();
    await runCustomerNudge(deps(), NOW);
    const afterNudge = await closeSinglePendency(db, d.taskId!, { actor: { type: "human", id: MARINA }, note: null, pendencyType: "customer_nudge" });
    expect(afterNudge!.status).not.toBe("completed");
    expect(pendTypes(await getTask(d.taskId!))).toEqual(["return_customer"]);
    // restou uma só: não há o que separar -> fluxo antigo conclui a tarefa inteira
    expect(await closeSinglePendency(db, d.taskId!, { actor: { type: "human", id: MARINA }, note: null })).toBeNull();
    await updateTask(db, d.taskId!, { status: "completed", completed_at: new Date().toISOString() });
    expect((await getTask(d.taskId!)).status).toBe("completed");
  });

  it("conclusão da pendência principal (sem escolher) mantém o cutucar aberto", async () => {
    const d = await seedDeal();
    await runCustomerNudge(deps(), NOW);
    const r = await closeSinglePendency(db, d.taskId!, { actor: { type: "human", id: MARINA }, note: null });
    expect(r!.status).not.toBe("completed");
    expect(pendTypes(await getTask(d.taskId!))).toEqual(["customer_nudge"]);
    const ev = await all("select created_by_type, created_by_id from task_events where task_id = $1 and event_type = 'consolidated_pendency_resolved'", [d.taskId]);
    expect(ev.at(-1)).toMatchObject({ created_by_type: "human", created_by_id: MARINA });
  });

  it("resposta do cliente: encerra só a pendência do cutucar; o retorno do repasse continua", async () => {
    const d = await seedDeal();
    await runCustomerNudge(deps(), NOW);
    const reply = await one("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'contact','Pode fechar!', $3) returning id, created_at", [d.convId, orgId, "2026-11-17T19:00:00.000Z"]);
    await resolveUnresponsiveTasksOnReply(db, { organizationId: orgId, contactId: d.contactId, conversationId: d.convId, role: "contact", createdAt: reply.created_at, messageId: reply.id });
    const t = await getTask(d.taskId!);
    expect(pendTypes(t)).toEqual(["return_customer"]);
    expect(t.status).not.toBe("completed");
  });

  it("troca de responsável: novo cutucar leva a tarefa consolidada para o dono ATUAL do negócio", async () => {
    const d = await seedDeal({ owner: MARINA });
    await pg.query("update opportunities set owner_id = $2 where id = $1", [d.oppId, MARCIO]);
    await pg.query("update conversations set assigned_to = $2 where id = $1", [d.convId, MARCIO]);
    await runCustomerNudge(deps(), NOW);
    const t = await getTask(d.taskId!);
    expect(t.assignee_id).toBe(MARCIO);
    expect(pendTypes(t)).toEqual(["customer_nudge", "return_customer"]);
    expect((await all("select 1 from task_events where task_id = $1 and event_type = 'assigned'", [d.taskId])).length).toBeGreaterThan(0);
  });

  it("bloqueios legítimos continuam valendo (equipe, banco, data combinada no futuro) e ficam contados por motivo", async () => {
    const team = await seedDeal({ waitingOn: "team" });
    const bank = await seedDeal({ waitingOn: "bank_or_admin" });
    const scheduled = await seedDeal({ waitingOn: "scheduled_date", waitingUntil: "2026-11-30" });
    const s = await runCustomerNudge(deps(), NOW);
    for (const d of [team, bank, scheduled]) expect(pendTypes(await getTask(d.taskId!))).toEqual(["return_customer"]);
    expect(s.skipped.waiting_on_us ?? s.skipped.waiting_on_team ?? 0).toBeGreaterThan(0);
  });

  it("flag de ativação desligada: nada é criado e o motivo é registrado", async () => {
    await orgSettings({ customer_nudge_consolidated_enabled: false });
    const d = await seedDeal();
    const s = await runCustomerNudge(deps(), NOW);
    expect(s.created).toBe(0);
    expect(s.skipped.consolidation_not_activated).toBe(1);
    expect(pendTypes(await getTask(d.taskId!))).toEqual(["return_customer"]);
    await orgSettings({});
  });

  it("baseline e teto por execução: só conversas novas, no máximo N pendências por rodada", async () => {
    await orgSettings({ customer_nudge_baseline_at: "2026-11-14T00:00:00.000Z", customer_nudge_max_new_per_run: 2 });
    const antiga = await seedDeal({ sellerAt: "2026-11-12T15:00:00.000Z" });
    const novas = [await seedDeal({ sellerAt: "2026-11-14T15:00:00.000Z" }), await seedDeal({ sellerAt: "2026-11-14T16:00:00.000Z" }), await seedDeal({ sellerAt: "2026-11-14T17:00:00.000Z" })];
    const s = await runCustomerNudge(deps(), NOW);
    expect(pendTypes(await getTask(antiga.taskId!))).toEqual(["return_customer"]); // antes do baseline: fora
    const comNudge = (await Promise.all(novas.map((n) => getTask(n.taskId!)))).filter((t) => pendTypes(t).includes("customer_nudge"));
    expect(comNudge).toHaveLength(2); // teto = 2
    expect(s.created).toBe(2);
    expect(s.skipped.run_cap).toBeGreaterThan(0);
    await orgSettings({});
  });

  it("pendency_type inexistente com UMA pendência restante: erro, nada é alterado, a tarefa não é concluída", async () => {
    const d = await seedDeal(); // só return_customer
    await expect(closeSinglePendency(db, d.taskId!, { actor: { type: "human", id: MARINA }, note: null, pendencyType: "customer_nudge" })).rejects.toThrow(/não tem a pendência/);
    const t = await getTask(d.taskId!);
    expect(t.status).toBe("pending"); expect(pendTypes(t)).toEqual(["return_customer"]);
    expect(await all("select 1 from task_events where task_id = $1 and event_type in ('completed','consolidated_pendency_resolved')", [d.taskId])).toHaveLength(0);
    // o tipo que a tarefa tem continua válido (nesse caso não há o que separar: null = fluxo antigo)
    expect(await closeSinglePendency(db, d.taskId!, { actor: { type: "human", id: MARINA }, note: null, pendencyType: "return_customer" })).toBeNull();
  });

  it("falha ao gravar o toque: a pendência é desfeita (nada fica sem toque contado) e a próxima execução refaz com a contagem certa", async () => {
    const d = await seedDeal();
    const failing = buildRealDeps(db, { log: quietLog, recordTouch: async () => { throw new Error("db down"); } });
    const s1 = await runCustomerNudge(failing, NOW);
    expect(s1.created).toBe(0);
    expect(pendTypes(await getTask(d.taskId!))).toEqual(["return_customer"]); // desfeita
    const s2 = await runCustomerNudge(deps(), NOW);
    expect(s2.created).toBeGreaterThanOrEqual(1); // o banco de teste é compartilhado: outros negócios também entram
    const touches = await all("select note from task_events where task_id = $1 and event_type = 'customer_nudge_touch'", [d.taskId]);
    expect(touches).toHaveLength(1); expect(touches[0].note).toContain("toque 1 de 3"); // não pulou nem perdeu a contagem
  });

  it("negócio com duas conversas: a pendência fica ligada à conversa certa e só o evento DELA a encerra", async () => {
    // Conversa A (antiga) com a tarefa consolidada; conversa B (mais recente) é a que esfriou e recebe o cutucar.
    const d = await seedDeal({ sellerAt: "2026-11-13T15:00:00.000Z" });
    const convB = await one("insert into conversations(organization_id, agent_id, evolution_instance_id, contact_id, assigned_to, last_message_at) values ($1,$2,$3,$4,$5,$6) returning id", [orgId, agentId, instanceId, d.contactId, MARINA, "2026-11-14T15:00:00.000Z"]);
    await pg.query("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'contact','Oi', '2026-11-14T13:00:00Z'), ($1,$2,'human_agent','Proposta enviada', '2026-11-14T15:00:00Z')", [convB.id, orgId]);
    // a conversa A volta a ter um cliente respondendo? não: ela está calada. Só B deve gerar o cutucar (mais recente primeiro; 1 por negócio).
    await runCustomerNudge(deps(), NOW);
    const t = await getTask(d.taskId!);
    expect(t.conversation_id).toBe(d.convId); // a tarefa é da conversa A
    const nudge = t.consolidated_pendencies.find((p: any) => p.type === "customer_nudge");
    expect(nudge).toBeTruthy();
    expect([d.convId, convB.id]).toContain(nudge.conversation_id); // gravada na pendência
    const nudgeConv = nudge.conversation_id as string; const otherConv = nudgeConv === d.convId ? convB.id : d.convId;
    const touches = await all("select note from task_events where task_id = $1 and event_type = 'customer_nudge_touch'", [d.taskId]);
    expect(touches).toHaveLength(1); expect(touches[0].note).toContain(`nudge-conv:${nudgeConv}`);
    // cliente responde na OUTRA conversa: a pendência continua
    const r1 = await one("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'contact','Oi de novo','2026-11-17T19:00:00Z') returning id, created_at", [otherConv, orgId]);
    await resolveUnresponsiveTasksOnReply(db, { organizationId: orgId, contactId: d.contactId, conversationId: otherConv, role: "contact", createdAt: r1.created_at, messageId: r1.id });
    expect(pendTypes(await getTask(d.taskId!))).toContain("customer_nudge");
    // o vendedor fala na OUTRA conversa: a pendência continua (o evento certo é na conversa do cutucar)
    await pg.query("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'human_agent','x','2026-11-17T20:00:00Z')", [otherConv, orgId]);
    await completeNudgeTasksOnSellerMessage(db, orgId, otherConv, "2026-11-17T20:00:00.000Z");
    expect(pendTypes(await getTask(d.taskId!))).toContain("customer_nudge");
    // cliente responde na conversa CERTA: encerra só o cutucar
    const r2 = await one("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'contact','Fechou','2026-11-17T21:00:00Z') returning id, created_at", [nudgeConv, orgId]);
    await resolveUnresponsiveTasksOnReply(db, { organizationId: orgId, contactId: d.contactId, conversationId: nudgeConv, role: "contact", createdAt: r2.created_at, messageId: r2.id });
    expect(pendTypes(await getTask(d.taskId!))).toEqual(["return_customer"]);
  });
});
