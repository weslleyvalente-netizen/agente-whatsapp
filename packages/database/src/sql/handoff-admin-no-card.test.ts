// Atendimento exclusivamente administrativo/pós-venda não abre card automático (decisão do dono 25/11), inclusive contato sem histórico.
// Nunca impede: encaminhamento, atribuição de responsável (rodízio) nem a tarefa de atendimento. Na dúvida (unclear/sem marca), o card
// continua sendo criado — não se descarta uma possível venda. Atrás da flag handoff_admin_no_card_enabled.
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });

const ON = { ...ALL_ON, handoff_admin_no_card_enabled: true };
const distribute = async (org: string, h: { conversationId: string; handoffId: string }) =>
  (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h.conversationId, h.handoffId, inMinutes(60)]))[0].id as string | null;
const opps = (contact: string) => q("select * from public.opportunities where contact_id=$1", [contact]);
const mark = (h: { handoffId: string }, intent: string | null) => q("update public.handoff_events set commercial_intent=$2 where id=$1", [h.handoffId, intent]);

describe("encaminhamento administrativo sem card", () => {
  it("administrativo + flag: sem card, mas com atribuição pelo rodízio e conversa com responsável", async () => {
    const { org } = await seedWorld(db, ON);
    const h = await seedLead(db, org);
    await mark(h, "administrative");
    const id = await distribute(org, h);
    const a = (await q("select rep_id, status, reason from public.lead_assignments where id=$1", [id]))[0];
    expect(a.rep_id).toBeTruthy();
    expect(a.status).toBe("pending");
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBeTruthy();
    expect(await opps(h.contactId)).toHaveLength(0);
  });

  it("na dúvida (unclear ou sem marca) o card continua sendo criado", async () => {
    const { org } = await seedWorld(db, ON);
    const a = await seedLead(db, org);
    await mark(a, "unclear");
    await distribute(org, a);
    expect(await opps(a.contactId)).toHaveLength(1);
    const b = await seedLead(db, org);
    await distribute(org, b);
    expect(await opps(b.contactId)).toHaveLength(1);
  });

  it("flag desligada: comportamento de hoje (cria card mesmo administrativo)", async () => {
    const { org } = await seedWorld(db, ALL_ON);
    const h = await seedLead(db, org);
    await mark(h, "administrative");
    await distribute(org, h);
    expect(await opps(h.contactId)).toHaveLength(1);
  });

  it("caminho posterior (escalada de SLA chama a mesma função) também respeita; novo encaminhamento comercial cria", async () => {
    const { org, reps } = await seedWorld(db, ON);
    const h = await seedLead(db, org);
    await mark(h, "administrative");
    expect((await q("select public._open_opportunity_for_handoff($1,$2,$3,$4) as id", [org, h.conversationId, h.contactId, reps["Marina"].userId]))[0].id).toBeNull();
    await q("insert into public.handoff_events(organization_id,conversation_id,handed_at,commercial_intent) values ($1,$2,now()+interval '1 minute','commercial')", [org, h.conversationId]);
    expect((await q("select public._open_opportunity_for_handoff($1,$2,$3,$4) as id", [org, h.conversationId, h.contactId, reps["Marina"].userId]))[0].id).not.toBeNull();
  });
});
