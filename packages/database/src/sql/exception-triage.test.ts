// P0a: migração exception_triage_alerts + camada de consulta, contra o esquema de distribuição REAL (PGlite).
// Exceção criada pelo caminho real (distribute_lead -> redistribute_assignment x2), nunca por INSERT à mão.
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_CALENDAR } from "@aula-agente/shared";
import { inMinutes } from "./harness.js";
import { ALL_ON, NEW_MIGRATIONS, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";
import { postgrestLite } from "./real-schema-db.js";
import {
  claimAlertSlot, finishAlertSlot, listAlertRecipientIds, listRecordedAlertStages, loadTriageItems, recordExceptionEvent, releaseAlertSlot, releaseStaleAlertClaims,
} from "../queries/exception-triage.js";

const MIGRATION = "20261116120000_exception_triage_alerts.sql";
let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
let client: any;
beforeEach(async () => {
  ({ db, q } = await setupHandoffDb({ apply: [...NEW_MIGRATIONS, MIGRATION] }));
  await q("alter table public.conversations add column if not exists status text");
  await q("alter table public.wa_contacts add column if not exists name text");
  client = postgrestLite(db as never);
  // postgrestLite não implementa rpc: executa a função SQL real com os mesmos argumentos nomeados do supabase-js.
  client.rpc = async (name: string, args: Record<string, unknown>) => {
    const keys = Object.keys(args);
    try {
      const res = await db.query<any>(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map(k => args[k]));
      return { data: res.rows[0].r, error: null };
    } catch (e: any) { return { data: null, error: { code: e.code, message: e.message } }; }
  };
});

const past = () => new Date(Date.now() - 60_000).toISOString();

/** Exceção REAL: dois vendedores estouram o SLA (Marina -> Márcio -> exceção all_reps_sla_breached). */
async function realException(handedMinutesAgo = 120) {
  const w = await seedWorld(db, ALL_ON, [["Marina", 1], ["Márcio", 2]]);
  const h = await seedLead(db, w.org, { handedAt: inMinutes(-handedMinutesAgo) });
  const first = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, past()]))[0].id as string;
  const second = (await q("select public.redistribute_assignment($1,$2) as id", [first, past()]))[0].id as string;
  const exception = (await q("select public.redistribute_assignment($1,$2) as id", [second, inMinutes(30)]))[0].id as string;
  return { ...w, h, first, second, exception };
}
const snapshot = async () => ({
  assignments: await q("select * from public.lead_assignments order by id"),
  state: await q("select * from public.lead_distribution_state order by organization_id"),
  reps: await q("select id, rotation_order, availability from public.sales_reps order by id"),
});
const message = (conversationId: string, org: string, role: string, content: string, at: string) =>
  q("insert into public.messages(organization_id,conversation_id,role,content,created_at) values ($1,$2,$3,$4,$5)", [org, conversationId, role, content, at]);

describe("migração: objetos novos, só aditivos", () => {
  it("cria as três tabelas e a função, com RLS ligada", async () => {
    const t = await q("select relname, relrowsecurity from pg_class where relname in ('exception_events','exception_alert_ledger','exception_alert_recipients') order by relname");
    expect(t).toEqual([
      { relname: "exception_alert_ledger", relrowsecurity: true }, { relname: "exception_alert_recipients", relrowsecurity: true }, { relname: "exception_events", relrowsecurity: true },
    ]);
    expect((await q("select count(*)::int n from pg_policies where tablename like 'exception_%'"))[0].n).toBe(0); // sem policies: só service role
    expect((await q("select count(*)::int n from pg_proc where proname='record_exception_event'"))[0].n).toBe(1);
  });
  it("privilégios: só a service role acessa tabelas e função; anon/authenticated (JWT do navegador) não", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const t of ["exception_events", "exception_alert_ledger", "exception_alert_recipients"]) {
        for (const priv of ["select", "insert", "update", "delete"]) {
          expect((await q("select has_table_privilege($1, $2, $3) as ok", [role, `public.${t}`, priv]))[0].ok, `${role} ${priv} ${t}`).toBe(false);
        }
      }
      expect((await q("select has_function_privilege($1, 'public.record_exception_event(uuid,uuid,text,uuid,text,uuid)', 'execute') as ok", [role]))[0].ok).toBe(false);
    }
    expect((await q("select has_table_privilege('service_role', 'public.exception_events', 'insert') as ok"))[0].ok).toBe(true);
    expect((await q("select has_function_privilege('service_role', 'public.record_exception_event(uuid,uuid,text,uuid,text,uuid)', 'execute') as ok"))[0].ok).toBe(true);
  });
  it("é idempotente (reaplicar não falha nem apaga dados)", async () => {
    const e = await realException();
    await recordExceptionEvent(client, { organizationId: e.org, assignmentId: e.exception, kind: "acknowledged", actorUserId: e.def });
    const { readFileSync } = await import("node:fs");
    await db.exec(readFileSync(new URL(`../../../../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8"));
    expect((await q("select count(*)::int n from public.exception_events"))[0].n).toBe(1);
  });
});

describe("record_exception_event", () => {
  it("reconhecer e resolver gravam ator, tipo, vendedor e nota SEM tocar lead_assignments, ponteiro ou vendedores", async () => {
    const e = await realException();
    const before = await snapshot();
    await recordExceptionEvent(client, { organizationId: e.org, assignmentId: e.exception, kind: "acknowledged", actorUserId: e.def, note: "vendo agora" });
    const id = await recordExceptionEvent(client, { organizationId: e.org, assignmentId: e.exception, kind: "resolved_confirmed", actorUserId: e.def, repId: e.reps["Marina"].repId, note: "Marina assumiu" });
    expect(id).toBeTruthy();
    const ev = await q("select kind, actor_user_id, rep_id, note from public.exception_events order by created_at, kind");
    expect(ev).toHaveLength(2);
    expect(ev.find(x => x.kind === "resolved_confirmed")).toMatchObject({ actor_user_id: e.def, rep_id: e.reps["Marina"].repId, note: "Marina assumiu" });
    expect(await snapshot()).toEqual(before); // histórico e rodízio intactos
  });
  it("resolver duas vezes com o mesmo tipo é idempotente; com tipo diferente é recusado", async () => {
    const e = await realException();
    const a = await recordExceptionEvent(client, { organizationId: e.org, assignmentId: e.exception, kind: "resolved_no_action", actorUserId: e.def, note: "cliente desistiu" });
    const b = await recordExceptionEvent(client, { organizationId: e.org, assignmentId: e.exception, kind: "resolved_no_action", actorUserId: e.def, note: "outra nota" });
    expect(b).toBe(a);
    await expect(q("select public.record_exception_event($1,$2,'resolved_confirmed',$3,'x',$4)", [e.org, e.exception, e.def, e.reps["Marina"].repId])).rejects.toThrow(/já foi resolvida/);
    expect((await q("select count(*)::int n from public.exception_events where kind like 'resolved%'"))[0].n).toBe(1);
  });
  it("regras de validação: confirmar exige vendedor da organização; 'sem ação' exige motivo; só exceção aberta", async () => {
    const e = await realException();
    const other = await realException();
    await expect(q("select public.record_exception_event($1,$2,'resolved_confirmed',$3,'x',null)", [e.org, e.exception, e.def])).rejects.toThrow(/vendedor/);
    await expect(q("select public.record_exception_event($1,$2,'resolved_confirmed',$3,'x',$4)", [e.org, e.exception, e.def, other.reps["Marina"].repId])).rejects.toThrow(/vendedor/); // vendedor de outra organização
    await expect(q("select public.record_exception_event($1,$2,'resolved_no_action',$3,'  ',null)", [e.org, e.exception, e.def])).rejects.toThrow(/motivo/);
    await expect(q("select public.record_exception_event($1,$2,'acknowledged',$3,null,null)", [e.org, e.first, e.def])).rejects.toThrow(/não é uma exceção/);
    await expect(q("select public.record_exception_event($1,$2,'acknowledged',$3,null,null)", [other.org, e.exception, e.def])).rejects.toThrow(/inexistente/); // exceção de outra organização
    await expect(q("select public.record_exception_event($1,$2,'qualquer',$3,null,null)", [e.org, e.exception, e.def])).rejects.toThrow(/inválido/);
  });
  it("exceção já encerrada por outro caminho (manual_assign) não aceita novo evento", async () => {
    const e = await realException();
    await q("update public.lead_assignments set resolved_at = now() where id=$1", [e.exception]);
    await expect(q("select public.record_exception_event($1,$2,'acknowledged',$3,null,null)", [e.org, e.exception, e.def])).rejects.toThrow(/encerrada/);
  });
});

describe("exception_events é append-only e tem no máximo uma resolução", () => {
  it("UPDATE e DELETE diretos são recusados, mesmo pela service role", async () => {
    const e = await realException();
    await recordExceptionEvent(client, { organizationId: e.org, assignmentId: e.exception, kind: "acknowledged", actorUserId: e.def });
    await expect(q("update public.exception_events set note='reescrito'")).rejects.toThrow(/somente de inserção/);
    await expect(q("delete from public.exception_events")).rejects.toThrow(/somente de inserção/);
  });
  it("o índice único barra uma segunda resolução gravada por fora da função (corrida)", async () => {
    const e = await realException();
    await q("insert into public.exception_events(organization_id,assignment_id,kind,actor_user_id,note) values ($1,$2,'resolved_no_action',$3,'a')", [e.org, e.exception, e.def]);
    await expect(q("insert into public.exception_events(organization_id,assignment_id,kind,actor_user_id,note) values ($1,$2,'resolved_no_action',$3,'b')", [e.org, e.exception, e.def])).rejects.toThrow(/duplicate key|unique/i);
  });
  it("o gatilho só libera DELETE em cascata de FK (profundidade > 1), nunca DELETE direto", async () => {
    await db.exec(`create table public.p_tmp(id int primary key); create table public.c_tmp(id int, p int references public.p_tmp(id) on delete cascade);
      create trigger c_tmp_guard before update or delete on public.c_tmp for each row execute function public.exception_events_append_only();
      insert into public.p_tmp values (1); insert into public.c_tmp values (1,1);`);
    await expect(q("delete from public.c_tmp")).rejects.toThrow(/somente de inserção/);
    await q("delete from public.p_tmp"); // cascata: permitida
    expect((await q("select count(*)::int n from public.c_tmp"))[0].n).toBe(0);
  });
});

describe("livro de alertas (idempotência)", () => {
  it("claim é atômico: o segundo devolve null (índice único); estágios registrados incluem pulados e sombra", async () => {
    const e = await realException();
    const c = { organizationId: e.org, assignmentId: e.exception, stage: 0 as const, channel: "push" as const, recipientUserId: e.def, mode: "on" as const };
    const first = await claimAlertSlot(client, c);
    expect(first).toBeTruthy();
    expect(await claimAlertSlot(client, c)).toBeNull();
    await claimAlertSlot(client, { ...c, stage: 15, channel: "skipped", recipientUserId: null });
    await claimAlertSlot(client, { ...c, stage: 30, channel: "shadow", mode: "shadow" });
    expect((await listRecordedAlertStages(client, [e.exception])).get(e.exception)!.sort((a, b) => a - b)).toEqual([0, 15, 30]);
  });
  it("destinatários diferentes no mesmo estágio coexistem; o mesmo destinatário em outro canal também", async () => {
    const e = await realException();
    const base = { organizationId: e.org, assignmentId: e.exception, stage: 0 as const, mode: "on" as const };
    expect(await claimAlertSlot(client, { ...base, channel: "push", recipientUserId: e.def })).toBeTruthy();
    expect(await claimAlertSlot(client, { ...base, channel: "push", recipientUserId: e.reps["Marina"].userId })).toBeTruthy();
    expect(await claimAlertSlot(client, { ...base, channel: "email", recipientUserId: e.def })).toBeTruthy();
  });
  it("estágios inválidos e canais inválidos são recusados pelo banco", async () => {
    const e = await realException();
    await expect(claimAlertSlot(client, { organizationId: e.org, assignmentId: e.exception, stage: 7 as never, channel: "push", recipientUserId: e.def, mode: "on" })).rejects.toBeTruthy();
    await expect(claimAlertSlot(client, { organizationId: e.org, assignmentId: e.exception, stage: 0, channel: "sms" as never, recipientUserId: e.def, mode: "on" })).rejects.toBeTruthy();
  });
  it("falha de envio: release solta a reserva; finish marca enviado; reservas antigas presas são soltas, enviadas nunca", async () => {
    const e = await realException();
    const base = { organizationId: e.org, assignmentId: e.exception, stage: 0 as const, channel: "push" as const, mode: "on" as const };
    const a = (await claimAlertSlot(client, { ...base, recipientUserId: e.def }))!;
    await releaseAlertSlot(client, a.id);
    expect((await q("select count(*)::int n from public.exception_alert_ledger"))[0].n).toBe(0);
    const b = (await claimAlertSlot(client, { ...base, recipientUserId: e.def }))!;
    const c = (await claimAlertSlot(client, { ...base, recipientUserId: e.reps["Marina"].userId }))!;
    await finishAlertSlot(client, c.id, "sent");
    await q("update public.exception_alert_ledger set created_at = now() - interval '10 minutes'");
    expect(await releaseStaleAlertClaims(client, 5 * 60_000)).toBe(1);
    expect((await q("select status from public.exception_alert_ledger"))).toEqual([{ status: "sent" }]);
    void b;
  });
  it("destinatários: só a lista explícita (vazia por padrão)", async () => {
    const e = await realException();
    expect(await listAlertRecipientIds(client, e.org)).toEqual([]);
    await q("insert into public.exception_alert_recipients(organization_id,user_id) values ($1,$2)", [e.org, e.def]);
    expect(await listAlertRecipientIds(client, e.org)).toEqual([e.def]);
  });
});

describe("loadTriageItems sobre exceção real", () => {
  it("classifica por conteúdo, preserva o handoff original e não altera nada", async () => {
    const e = await realException(180);
    await message(e.h.conversationId, e.org, "human_agent", "Bom dia", inMinutes(-20));
    await message(e.h.conversationId, e.org, "contact", "oi, quero a carta", inMinutes(-10));
    const before = await snapshot();
    const items = await loadTriageItems(client, e.org, DEFAULT_BUSINESS_CALENDAR);
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.kind).toBe("exception");
    expect(it0.chainReps.sort()).toEqual(["Marina", "Márcio"]);
    expect(it0.triage).toMatchObject({ state: "aguardando_atendimento_comercial", group: "urgente", clientWaiting: true, hasCommercialReply: false });
    // âncora = primeiro handoff (180 min atrás), nunca a criação da exceção
    expect(it0.triage.accumulatedWallMinutes).toBeGreaterThanOrEqual(179);
    expect(it0.triage.sinceFlaggedWallMinutes).toBeLessThan(5);
    expect(await snapshot()).toEqual(before);
  });
  it("resposta comercial com a bola no cliente => respondida sem aceite; evento resolved_* => sai da lista de pendências com estado resolvida", async () => {
    const e = await realException();
    await message(e.h.conversationId, e.org, "human_agent", "temos sim cartas contempladas, posso te enviar as opções agora?", inMinutes(-5));
    let items = await loadTriageItems(client, e.org, DEFAULT_BUSINESS_CALENDAR);
    expect(items[0].triage).toMatchObject({ state: "respondida_sem_aceite", group: "respondida", needsOwnerConfirmation: true });
    await recordExceptionEvent(client, { organizationId: e.org, assignmentId: e.exception, kind: "resolved_confirmed", actorUserId: e.def, repId: e.reps["Marina"].repId });
    items = await loadTriageItems(client, e.org, DEFAULT_BUSINESS_CALENDAR);
    expect(items[0].triage).toMatchObject({ state: "resolvida", group: null });
    expect(items[0].events.map(x => x.kind)).toEqual(["resolved_confirmed"]);
  });
  it("exceção encerrada por manual_assign (resolved_at) some da lista", async () => {
    const e = await realException();
    await q("update public.lead_assignments set resolved_at = now() where id=$1", [e.exception]);
    expect(await loadTriageItems(client, e.org, DEFAULT_BUSINESS_CALENDAR)).toEqual([]);
  });
  it("organizações isoladas: só enxerga as exceções da própria organização", async () => {
    const a = await realException();
    const b = await realException();
    const items = await loadTriageItems(client, a.org, DEFAULT_BUSINESS_CALENDAR);
    expect(items.map(i => i.assignment.id)).toEqual([a.exception]);
    void b;
  });
});
