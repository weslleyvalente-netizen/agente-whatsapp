import { beforeAll, describe, expect, it } from "vitest";
import { AWAITING_CUSTOMER_NEXT_ACTION, CUSTOMER_REPLIED_NEXT_ACTION, HANDOFF_AUTO_NEXT_ACTION } from "@aula-agente/shared";
import { syncWaitingOnAfterCustomerReply, syncWaitingOnAfterHumanCompletion, syncWaitingOnAfterSellerMessage } from "./waiting-on-sync.js";

// ESQUEMA REAL: as migrações de supabase/migrations (inclusive a da tabela de sombra) num Postgres embutido, com as constraints de produção.
const REAL_SCHEMA_DB = "../../../../packages/database/src/sql/real-schema-db.ts"; // import dinâmico: o tsc da API não segue arquivos fora do rootDir
let pg: { query<T = any>(sql: string, p?: unknown[]): Promise<{ rows: T[] }> }; let db: any; let org: string; let seq = 0;
const one = async (sql: string, p: unknown[] = []) => (await pg.query(sql, p)).rows[0] as any;
const setSettings = (s: object) => pg.query("update organizations set settings=$2::jsonb where id=$1", [org, JSON.stringify(s)]);

async function deal(over: { stage?: string; waiting_on?: string; next_action?: string } = {}) {
  seq++;
  const contact = (await one("insert into wa_contacts(organization_id, phone) values ($1,$2) returning id", [org, `5562900000${String(seq).padStart(3, "0")}`])).id;
  const o = await one("insert into opportunities(organization_id, contact_id, operation, initial_operation, stage, waiting_on, next_action) values ($1,$2,'consortium','consortium',$3,$4,$5) returning id",
    [org, contact, over.stage ?? "decision_negotiation", over.waiting_on ?? "team", over.next_action ?? CUSTOMER_REPLIED_NEXT_ACTION]);
  return { contact, opp: o.id as string };
}
const state = (id: string) => one("select waiting_on, next_action from opportunities where id=$1", [id]);

beforeAll(async () => {
  const { createRealSchemaDb } = await import(/* @vite-ignore */ REAL_SCHEMA_DB);
  const env = await createRealSchemaDb(); pg = env.pg; db = env.client;
  expect(env.failedMigrations).toEqual([]);
  org = (await one("insert into organizations(name, slug, settings) values ('MT','mt','{}') returning id")).id;
}, 180_000);

describe("waiting_on sync no esquema real", () => {
  it("modo on: a proposta do vendedor muda o negócio e grava waiting_on_changed (passa nas constraints reais) com antes, depois, origem e motivo", async () => {
    await setSettings({ waiting_on_sync_mode: "on" });
    const d = await deal();
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: d.contact, role: "human_agent", content: "consórcio 40.000 61 x 575,95", messageId: "m1" })).toBe("set_customer");
    expect(await state(d.opp)).toEqual({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION });
    const ev = await one("select * from opportunity_events where opportunity_id=$1", [d.opp]);
    expect(ev).toMatchObject({ event_type: "waiting_on_changed", changed_by_type: "system" });
    expect(ev.previous_value).toEqual({ waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION });
    expect(ev.new_value).toEqual({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION });
    expect(ev.evidence).toContain("origem=seller_message"); expect(ev.evidence).toContain("regra=seller_proposal");
  });
  it("ida e volta: cliente responde (equipe) e o vendedor faz nova proposta (cliente), cada mudança com evento", async () => {
    await setSettings({ waiting_on_sync_mode: "on" });
    const d = await deal({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION });
    expect(await syncWaitingOnAfterCustomerReply(db, { organizationId: org, contactId: d.contact, role: "contact", content: "e se for 48x?" })).toBe("set_team");
    expect((await state(d.opp)).waiting_on).toBe("team");
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: d.contact, role: "human_agent", content: "48x de R$ 690, entrada R$ 8.000" })).toBe("set_customer");
    expect((await pg.query("select 1 from opportunity_events where opportunity_id=$1", [d.opp])).rows).toHaveLength(2);
  });
  it("modo shadow: registra na tabela nova o que FARIA e não altera o negócio nem grava evento", async () => {
    await setSettings({ waiting_on_sync_mode: "shadow" });
    const d = await deal();
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: d.contact, role: "human_agent", content: "esse ficaria bom pra você ?", messageId: "m9" })).toBe("shadow:seller_question");
    expect(await state(d.opp)).toEqual({ waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION });
    expect((await pg.query("select 1 from opportunity_events where opportunity_id=$1", [d.opp])).rows).toHaveLength(0);
    const sh = await one("select * from waiting_on_sync_shadow where opportunity_id=$1", [d.opp]);
    expect(sh).toMatchObject({ rule: "seller_question", trigger: "seller_message" });
    expect(sh.would_set).toEqual({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION });
    expect(sh.observed).toMatchObject({ waiting_on: "team", stage: "decision_negotiation" });
  });
  it("preserva decisões humanas e da equipe: etapa de simulação, tarefa de simulação aberta, texto próprio e data combinada", async () => {
    await setSettings({ waiting_on_sync_mode: "on" });
    const sim = await deal({ stage: "awaiting_simulation" });
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: sim.contact, role: "human_agent", content: "entrada R$ 8.000, 56x", messageId: "a" })).toBe("team_owned_stage");
    const withTask = await deal();
    await pg.query("insert into tasks(organization_id, contact_id, opportunity_id, type, title, due_date, created_by_type, status) values ($1,$2,$3,'run_quote','Fazer simulação','2026-11-20','ai','pending')", [org, withTask.contact, withTask.opp]);
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: withTask.contact, role: "human_agent", content: "entrada R$ 8.000, 56x", messageId: "b" })).toBe("other_open_tasks");
    const edited = await deal({ next_action: "Ligar amanhã às 10h" });
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: edited.contact, role: "human_agent", content: "entrada R$ 8.000, 56x", messageId: "c" })).toBe("next_action_edited");
    const scheduled = await deal({ waiting_on: "scheduled_date" });
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: scheduled.contact, role: "human_agent", content: "entrada R$ 8.000, 56x", messageId: "d" })).toBe("not_waiting_team");
    for (const x of [sim, withTask]) expect((await state(x.opp)).waiting_on).toBe("team");
    expect((await state(scheduled.opp)).waiting_on).toBe("scheduled_date");
  });
  it("modo off (padrão): nada acontece", async () => {
    await setSettings({});
    const d = await deal();
    expect(await syncWaitingOnAfterSellerMessage(db, { organizationId: org, contactId: d.contact, role: "human_agent", content: "entrada R$ 8.000, 56x" })).toBe("disabled");
    expect((await state(d.opp)).waiting_on).toBe("team");
  });
  it("conclusão da tarefa de atendimento no esquema real: 'aguardando cliente' + evento (gatilho task_completed); cliente esperando não vira", async () => {
    await setSettings({ waiting_on_sync_mode: "on" });
    const agent = (await one("insert into agents(organization_id, name, system_prompt) values ($1,'M','x') returning id", [org])).id;
    const inst = (await one("insert into evolution_instances(organization_id, instance_name, instance_id) values ($1,'weslley','a') returning id", [org])).id;
    const mk = async (lastRole: "human_agent" | "contact") => {
      const d = await deal({ next_action: HANDOFF_AUTO_NEXT_ACTION });
      const conv = (await one("insert into conversations(organization_id, agent_id, evolution_instance_id, contact_id) values ($1,$2,$3,$4) returning id", [org, agent, inst, d.contact])).id;
      const t = await one("insert into tasks(organization_id, contact_id, conversation_id, opportunity_id, type, title, due_date, created_by_type, status, created_at) values ($1,$2,$3,$4,'return_customer','Retornar cliente','2026-11-13','ai','completed','2026-11-13T10:00:00Z') returning *", [org, d.contact, conv, d.opp]);
      await pg.query("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'human_agent','Boa tarde, segue a proposta','2026-11-13T10:30:00Z')", [conv, org]);
      if (lastRole === "contact") await pg.query("insert into messages(conversation_id, organization_id, role, content, created_at) values ($1,$2,'contact','mas qual a entrada?','2026-11-13T10:40:00Z')", [conv, org]);
      return { ...d, task: t };
    };
    const ok = await mk("human_agent");
    expect(await syncWaitingOnAfterHumanCompletion(db, ok.task)).toBe("set_customer");
    expect(await state(ok.opp)).toEqual({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION });
    expect((await one("select evidence from opportunity_events where opportunity_id=$1", [ok.opp])).evidence).toContain("origem=task_completed");
    const waiting = await mk("contact");
    expect(await syncWaitingOnAfterHumanCompletion(db, waiting.task)).toBe("customer_waiting");
    expect((await state(waiting.opp)).waiting_on).toBe("team");
  });
});
