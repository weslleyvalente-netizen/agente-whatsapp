// Revisão integrada #123 + #124 + #125 + #126 (25/11): migrações aplicadas juntas, na ordem de produção.
// 1) Compatibilidade das funções redefinidas por mais de um PR. 2) Com TODAS as flags novas desligadas, o comportamento visível é o de hoje
// (exceto a correção de identidade do #123, que só bloqueia card de cadastro duplicado de cliente com histórico).
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });
const src = async (fn: string) => (await q("select string_agg(prosrc, ' ') s from pg_proc where proname=$1", [fn]))[0].s as string;
const distribute = async (org: string, h: { conversationId: string; handoffId: string }, ctx: object = {}) =>
  (await q("select public.distribute_lead($1,$2,$3,$4,$5::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(60), JSON.stringify(ctx)]))[0].id;

describe("compatibilidade das funções SQL (ordem 20261125 -> 20261126120000 -> 20261126130000)", () => {
  it("histórico e tarefa: versão final = grupo de identidade (#123) + ignora anulado (#124)", async () => {
    for (const fn of ["_contact_has_deal_history", "_open_opportunity_for_task"]) {
      const s = await src(fn);
      expect(s, fn).toContain("_contact_identity_ids");
      expect(s, fn).toContain("'void'");
    }
  });
  it("card de encaminhamento: versão do #126 (marca administrativa) chamando o histórico do #123/#124", async () => {
    const s = await src("_open_opportunity_for_handoff");
    expect(s).toContain("handoff_admin_no_card_enabled");
    expect(s).toContain("_contact_has_deal_history");
  });
});

describe("todas as flags novas desligadas", () => {
  it("encaminhamento de lead novo: card criado como hoje, mesmo com marca administrativa; operação do contexto respeitada (#125)", async () => {
    const { org } = await seedWorld(db, ALL_ON);
    const a = await seedLead(db, org);
    await q("update public.handoff_events set commercial_intent='administrative' where id=$1", [a.handoffId]);
    await distribute(org, a);
    expect(await q("select 1 from public.opportunities where contact_id=$1 and status='open'", [a.contactId])).toHaveLength(1);
    const b = await seedLead(db, org);
    await distribute(org, b, { operation: "contemplated_letter" });
    expect((await q("select operation, operation_is_default from public.opportunities where contact_id=$1", [b.contactId]))[0]).toEqual({ operation: "contemplated_letter", operation_is_default: false });
  });

  it("cliente que volta e encerramento: nada cria, nada encerra", async () => {
    const { org, reps } = await seedWorld(db, ALL_ON);
    const c = (await q("insert into public.wa_contacts(organization_id,phone) values ($1,'5562990001234') returning id", [org]))[0].id;
    const prev = (await q("insert into public.opportunities(organization_id,contact_id,status,stage,owner_id,operation,initial_operation) values ($1,$2,'lost','qualification',$3,'vehicle_sale','vehicle_sale') returning id", [org, c, reps["Marina"].userId]))[0].id;
    const d = (await q(`insert into public.returning_customer_decisions(organization_id,contact_id,trigger_kind,trigger_id,mode,intent,identity_status,operation,stage,reason,previous_opportunity_id,outcome)
      values ($1,$2,'handoff',gen_random_uuid(),'write','commercial','resolved','vehicle_sale','qualification','x',$3,'would_create') returning id`, [org, c, prev]))[0].id;
    expect((await q("select public.open_returning_customer_opportunity($1) as id", [d]))[0].id).toBeNull();
    const conv = (await q("insert into public.conversations(organization_id,contact_id,evolution_instance_id) values ($1,$2,gen_random_uuid()) returning id", [org, c]))[0].id;
    const m = (await q("insert into public.messages(organization_id,conversation_id,role,content,evolution_message_id,metadata) values ($1,$2,'agent','Vou encerrar','evo','{\"no_reply_closure\":{}}') returning id", [org, conv]))[0].id;
    expect((await q("select public.apply_no_reply_closure($1) as n", [m]))[0].n).toBe(0);
  });

  it("anulado (#124) só existe por ação do gestor: nenhum card muda de status sozinho", async () => {
    const { org } = await seedWorld(db, ALL_ON);
    const h = await seedLead(db, org);
    await distribute(org, h);
    expect((await q("select count(*)::int n from public.opportunities where status='void'"))[0].n).toBe(0);
  });
});
