// Negócio anulado (void): só gestor, motivo obrigatório, auditoria, reversível, fora dos indicadores e do histórico comercial.
// Casos reais: Cleber (card 18/11 marcado ganho) e Rosival (card 21/11 aberto), criados por cadastro @lid duplicado para pós-venda.
import { beforeEach, describe, expect, it } from "vitest";
import { ALL_ON, NEW_MIGRATIONS, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
const VOID = "20261126120000_opportunity_void.sql";
beforeEach(async () => {
  ({ db, q } = await setupHandoffDb({ apply: [...NEW_MIGRATIONS.filter((f) => f !== VOID), "20261022120000_won_closes_open_tasks.sql", VOID] }));
  // Colunas que o gatilho de ganho (20261022120000, já aplicado acima com o gatilho) usa e o fixture não tem.
  await db.exec("ALTER TABLE public.tasks ADD COLUMN IF NOT EXISTS completed_at timestamptz, ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()");
});

async function world() {
  const w = await seedWorld(db, ALL_ON);
  const c = (await q("insert into public.wa_contacts(organization_id,phone) values ($1,'5562991110000') returning id", [w.org]))[0].id as string;
  const opp = (status: string, lost: string | null = null, created = "now()") =>
    q(`insert into public.opportunities(organization_id,contact_id,status,stage,operation,initial_operation,lost_reason,owner_id,created_at)
       values ($1,$2,$3,'interest_received','vehicle_sale','vehicle_sale',$4,$5,${created}) returning id`, [w.org, c, status, lost, w.reps["Márcio"].userId]).then((r) => r[0].id as string);
  return { ...w, c, opp, manager: w.def, seller: w.reps["Márcio"].userId };
}
const voidIt = (id: string, actor: string, reason = "Card de pós-venda criado por cadastro @lid duplicado") =>
  q("select public.void_opportunity($1,$2,$3) as r", [id, actor, reason]).then((r) => r[0].r);
const unvoid = (id: string, actor: string, reason = "Anulação feita por engano, restaurando") =>
  q("select public.unvoid_opportunity($1,$2,$3) as r", [id, actor, reason]).then((r) => r[0].r);

describe("negócio anulado", () => {
  it("gestor anula com motivo: status 'void', auditoria com o estado anterior; tarefas abertas não mudam", async () => {
    const w = await world();
    const won = await w.opp("won");
    const task = (await q("insert into public.tasks(organization_id,contact_id,opportunity_id,assignee_type,assignee_id,type,due_date,created_by_type) values ($1,$2,$3,'human',$4,'vehicle_followup',current_date,'ai') returning id", [w.org, w.c, won, w.seller]))[0].id;
    const r = await voidIt(won, w.manager);
    expect(r).toMatchObject({ previous: { status: "won" }, open_tasks: 1 });
    expect((await q("select status, void_reason, voided_by from public.opportunities where id=$1", [won]))[0]).toEqual({ status: "void", void_reason: "Card de pós-venda criado por cadastro @lid duplicado", voided_by: w.manager });
    const ev = (await q("select event_type, previous_value, changed_by_type, changed_by_id, evidence from public.opportunity_events where opportunity_id=$1 and event_type='voided'", [won]))[0];
    expect(ev).toMatchObject({ previous_value: { status: "won" }, changed_by_type: "human", changed_by_id: w.manager });
    expect(ev.evidence).toContain("cadastro @lid duplicado");
    expect((await q("select status, opportunity_id from public.tasks where id=$1", [task]))[0]).toEqual({ status: "pending", opportunity_id: won });
    expect(await voidIt(won, w.manager)).toMatchObject({ already_void: true });
    expect(await q("select 1 from public.opportunity_events where opportunity_id=$1 and event_type='voided'", [won])).toHaveLength(1);
  });

  it("vendedor não anula nem desfaz; motivo vazio ou curto é recusado", async () => {
    const w = await world();
    const o = await w.opp("open");
    await expect(voidIt(o, w.seller)).rejects.toThrow(/Somente gestores/);
    await expect(voidIt(o, w.manager, "  curto ")).rejects.toThrow(/Motivo obrigatório/);
    await expect(voidIt(o, w.manager, "")).rejects.toThrow(/Motivo obrigatório/);
    await voidIt(o, w.manager);
    await expect(unvoid(o, w.seller)).rejects.toThrow(/Somente gestores/);
    expect((await q("select status from public.opportunities where id=$1", [o]))[0].status).toBe("void");
  });

  it("blindado: nenhuma outra rotina ganha, perde, reabre ou mexe num anulado; nada vira anulado sem a função", async () => {
    const w = await world();
    const o = await w.opp("open");
    await expect(q("update public.opportunities set status='void' where id=$1", [o])).rejects.toThrow(/anulação/);
    await voidIt(o, w.manager);
    for (const s of ["won", "lost", "open"]) await expect(q("update public.opportunities set status=$2 where id=$1", [o, s])).rejects.toThrow(/anulação/);
    await expect(q("update public.opportunities set stage='qualification' where id=$1", [o])).rejects.toThrow(/desfaça/);
  });

  it("desfazer devolve exatamente o estado anterior (perdido com motivo; ganho sem concluir de novo as tarefas do contato)", async () => {
    const w = await world();
    const lost = await w.opp("lost", "sem_resposta");
    await voidIt(lost, w.manager);
    expect(await unvoid(lost, w.manager)).toMatchObject({ restored: { status: "lost", lost_reason: "sem_resposta" } });
    expect((await q("select status, lost_reason, void_reason, void_previous from public.opportunities where id=$1", [lost]))[0]).toEqual({ status: "lost", lost_reason: "sem_resposta", void_reason: null, void_previous: null });
    const won = await w.opp("won");
    await voidIt(won, w.manager);
    const task = (await q("insert into public.tasks(organization_id,contact_id,assignee_type,assignee_id,type,due_date,created_by_type) values ($1,$2,'human',$3,'vehicle_followup',current_date,'ai') returning id", [w.org, w.c, w.seller]))[0].id;
    await unvoid(won, w.manager);
    expect((await q("select status from public.opportunities where id=$1", [won]))[0].status).toBe("won");
    expect((await q("select status from public.tasks where id=$1", [task]))[0].status).toBe("pending");
    expect((await q("select count(*)::int n from public.opportunity_events where opportunity_id=$1 and event_type in ('voided','unvoided')", [won]))[0].n).toBe(2);
  });

  it("fora do histórico comercial: anulado não bloqueia card novo nem vira 'negócio anterior' do cliente que volta", async () => {
    const w = await world();
    const o = await w.opp("won");
    expect((await q("select public._contact_has_deal_history($1,$2) as h", [w.org, w.c]))[0].h).toBe(true);
    await voidIt(o, w.manager);
    expect((await q("select public._contact_has_deal_history($1,$2) as h", [w.org, w.c]))[0].h).toBe(false);
    expect((await q("select public.returning_customer_context($1,$2) as c", [w.org, w.c]))[0].c).toMatchObject({ previous: null, open: [] });
  });

  it("fora dos indicadores de origem de anúncio (view opportunity_ad_origins)", async () => {
    const w = await world();
    const keep = await w.opp("won");
    const gone = await w.opp("won");
    await voidIt(gone, w.manager);
    expect((await q("select opportunity_id from public.opportunity_ad_origins where organization_id=$1", [w.org])).map((r: any) => r.opportunity_id)).toEqual([keep]);
  });
});
