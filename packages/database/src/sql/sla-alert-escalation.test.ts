// Estágio 2 da escalada: atribuição 'alert' (dono existente / manual) sem resposta passa ao próximo vendedor, no máximo uma vez por cadeia.
import { beforeEach, describe, expect, it } from "vitest";
import { inMinutes } from "./harness.js";
import { ALL_ON, seedLead, seedWorld, setupHandoffDb, type Db } from "./handoff-fixture.js";

let db: Db;
let q: (sql: string, p?: unknown[]) => Promise<any[]>;
beforeEach(async () => { ({ db, q } = await setupHandoffDb()); });

const ON = { ...ALL_ON, sla_alert_escalation_enabled: true };
const THREE: Array<[string, number, string?]> = [["Marina", 1], ["Márcio", 2], ["Paulo", 3]];

/** Caso real: cliente da carteira da Marina (existing_owner, alerta) com o prazo já vencido. */
async function breached(settings: Record<string, unknown> = ON, reps: Array<[string, number, string?]> = THREE, owner = "Marina", dueInMinutes = -70) {
  const w = await seedWorld(db, settings, reps);
  const h = await seedLead(db, w.org, { assignedTo: w.reps[owner].userId, handedAt: inMinutes(-130) });
  const id = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(dueInMinutes)]))[0].id as string;
  return { ...w, h, id };
}
const escalate = async (id: string, escalateInMinutes = -5) =>
  (await q("select public.escalate_alert_assignment($1,$2,$3) as id", [id, inMinutes(escalateInMinutes), inMinutes(60)]))[0].id as string | null;
const row = async (id: string) => (await q("select * from public.lead_assignments where id=$1", [id]))[0];

describe("escalate_alert_assignment", () => {
  it("caso real: dono existente sem resposta passa ao próximo vendedor; conversa, negócio e tarefas seguem; SLA novo; ponteiro acompanha", async () => {
    const { org, def, reps, h, id } = await breached();
    await q("insert into public.tasks(organization_id,contact_id,conversation_id,assignee_type,assignee_id,type,due_date,created_by_type) values ($1,$2,$3,'human',$4,'run_quote',current_date,'ai')", [org, h.contactId, h.conversationId, def]);
    const old = await row(id);
    expect(old).toMatchObject({ reason: "existing_owner", sla_action: "alert", status: "pending" });
    const nid = await escalate(id);
    expect(nid).toBeTruthy();
    expect(await row(id)).toMatchObject({ status: "redistributed", redistribution_reason: "sla_escalation", sla_breached: true, next_assignment_id: nid });
    const n = await row(nid!);
    expect(n).toMatchObject({ status: "pending", reason: "sla_redistribution", sla_action: "alert", rep_id: reps["Márcio"].repId, previous_assignment_id: id,
      chain_id: old.chain_id, handoff_event_id: old.handoff_event_id, opportunity_id: old.opportunity_id, sla_breached: false });
    expect(new Date(n.handoff_at).getTime()).toBe(new Date(old.handoff_at).getTime());
    expect(new Date(n.sla_due_at).getTime()).toBeGreaterThan(Date.now());
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBe(reps["Márcio"].userId);
    expect((await q("select owner_id from public.opportunities where id=$1", [old.opportunity_id]))[0].owner_id).toBe(reps["Márcio"].userId);
    expect((await q("select distinct assignee_id from public.tasks where contact_id=$1", [h.contactId])).map(r => r.assignee_id)).toEqual([reps["Márcio"].userId]);
    expect((await q("select last_rotation_order from public.lead_distribution_state where organization_id=$1", [org]))[0].last_rotation_order).toBe(2);
    // o gatilho de "novo lead" do push enxerga a nova atribuição: pendente, com vendedor, criada agora
    expect(n).toMatchObject({ status: "pending" });
    expect(new Date(n.created_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // um lead novo do rodízio depois da escalada vai ao vendedor seguinte ao que recebeu a escalada (Paulo)
    const h2 = await seedLead(db, org);
    const rr = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [org, h2.conversationId, h2.handoffId, inMinutes(60)]))[0].id;
    expect((await row(rr)).rep_id).toBe(reps["Paulo"].repId);
  });

  it("atribuição manual (alert) também escala", async () => {
    const { org, def, reps, h } = await breached(ON, THREE, "Marina", 60);
    // o gestor atribui manualmente ao Márcio (prazo curto já vencido)
    const first = (await q("select id from public.lead_assignments where conversation_id=$1 and status='pending'", [h.conversationId]))[0].id;
    const manual = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, reps["Márcio"].repId, def, inMinutes(-70)]))[0].id;
    expect((await row(manual))).toMatchObject({ reason: "manual", sla_action: "alert" });
    const nid = await escalate(manual);
    expect((await row(nid!)).rep_id).toBe(reps["Paulo"].repId); // depois do Márcio na ordem; nunca Marina (já esteve na cadeia)
    expect((await row(first)).status).toBe("redistributed");
  });

  it("chave desligada, ausente ou não-booleana: não faz nada; distribuição desligada também", async () => {
    for (const settings of [ALL_ON, { ...ALL_ON, sla_alert_escalation_enabled: false }, { ...ALL_ON, sla_alert_escalation_enabled: "true" }, { sla_alert_escalation_enabled: true, sales_auto_pipeline_enabled: true }]) {
      const { id } = await breached(settings, THREE).catch(async () => ({ id: "" }));
      if (!id) continue; // distribuição desligada: nem atribuição existe
      expect(await escalate(id)).toBeNull();
      expect((await row(id)).status).toBe("pending");
    }
    const w = await breached(ON);
    await q("update public.organizations set settings = settings || '{\"lead_distribution_enabled\":false}' where id=$1", [w.org]);
    expect(await escalate(w.id)).toBeNull();
  });

  it("antes da hora: p_escalate_at no futuro ou prazo do SLA ainda não vencido => não age", async () => {
    const early = await breached(ON, THREE, "Marina", 30);
    expect(await escalate(early.id, -5)).toBeNull(); // sla_due_at ainda no futuro
    const w = await breached();
    expect(await escalate(w.id, 10)).toBeNull(); // 2x o SLA ainda não chegou
    expect((await row(w.id)).status).toBe("pending");
    expect(await escalate(w.id, -1)).toBeTruthy();
  });

  it("cliente já respondido: nada a escalar (mensagem humana desde o handoff, marco de primeira resposta ou atribuição já aceita)", async () => {
    // mensagem de humano na conversa DEPOIS do handoff
    let w = await breached();
    await q("insert into public.messages(organization_id,conversation_id,role,content,created_at,evolution_message_id) values ($1,$2,'human_agent','Oi, já te atendo',$3,'wa-'||gen_random_uuid())", [w.org, w.h.conversationId, inMinutes(-20)]);
    expect(await escalate(w.id)).toBeNull();
    // atribuição aceita por mensagem do vendedor
    w = await breached();
    await q("select public.record_human_message($1,$2,now(),$3,'panel')", [w.org, w.h.conversationId, w.reps["Marina"].userId]);
    expect((await row(w.id)).status).toBe("accepted");
    expect(await escalate(w.id)).toBeNull();
    // marco de primeira resposta com a atribuição ainda pendente (resposta de outro humano)
    w = await breached();
    await q("update public.lead_assignments set first_human_message_at=now() where id=$1", [w.id]);
    expect(await escalate(w.id)).toBeNull();
  });

  it("conversa com histórico humano ANTIGO (antes do handoff) não impede a escalada", async () => {
    const w = await breached();
    await q("insert into public.messages(organization_id,conversation_id,role,content,created_at,evolution_message_id) values ($1,$2,'human_agent','conversa de meses atrás',$3,'wa-'||gen_random_uuid())", [w.org, w.h.conversationId, inMinutes(-60 * 24 * 90)]);
    expect(await escalate(w.id)).toBeTruthy();
  });

  // Histórico real do Claudivan: Marina (rodízio) -> Márcio (SLA) atende -> cliente volta (novo handoff) e o Márcio não responde.
  async function claudivan(w: Awaited<ReturnType<typeof breached>>, marcioMessage?: { at: number; id: string | null; meta?: object; role?: string }, marinaMessageAt?: number) {
    const conv = w.h.conversationId;
    const prior = async (rep: string, minutes: number, reason: string) => {
      const ho = (await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3) returning id", [w.org, conv, inMinutes(minutes)]))[0].id;
      await q(`insert into public.lead_assignments(organization_id,chain_id,handoff_event_id,contact_id,conversation_id,rep_id,reason,status,assigned_at,handoff_at,strategy_version)
               values ($1,gen_random_uuid(),$2,$3,$4,$5,$6,'redistributed',$7,$7,'test')`, [w.org, ho, w.h.contactId, conv, w.reps[rep].repId, reason, inMinutes(minutes)]);
    };
    await prior("Paulo", -60 * 60, "round_robin");     // 1º handoff da conversa
    await prior("Marina", -60 * 59, "round_robin");    // Marina teve o lead primeiro
    await prior("Márcio", -60 * 40, "sla_redistribution"); // Márcio assume depois do SLA da Marina
    // a atribuição pendente (w.id) é do dono "Marina" em breached(); passa para o Márcio como dono atual
    await q("update public.lead_assignments set rep_id=rep_id where id=$1", [w.id]);
    if (marinaMessageAt !== undefined) await q("insert into public.messages(organization_id,conversation_id,role,content,created_at,evolution_message_id) values ($1,$2,'human_agent','msg da Marina',$3,'wa-marina')", [w.org, conv, inMinutes(marinaMessageAt)]);
    if (marcioMessage) await q("insert into public.messages(organization_id,conversation_id,role,content,created_at,evolution_message_id,metadata) values ($1,$2,$5,'msg do Márcio',$3,$4,$6)", [w.org, conv, inMinutes(marcioMessage.at), marcioMessage.id, marcioMessage.role ?? "human_agent", JSON.stringify(marcioMessage.meta ?? {})]);
  }
  const marcioOwner = async () => {
    const w = await breached(ON, THREE, "Márcio");
    return w;
  };

  it("protege: o responsável atual já conversou (mensagem confirmada dentro do seu período), mesmo com novo encaminhamento sem resposta", async () => {
    const w = await marcioOwner();
    await claudivan(w, { at: -60 * 30, id: "wa-1" });
    expect(await escalate(w.id)).toBeNull();
    expect((await row(w.id)).status).toBe("pending");
    expect(await q("select id from public.list_escalation_candidates(50) where id=$1", [w.id])).toHaveLength(0);
  });

  it("não protege: mensagem humana ANTIGA, anterior ao primeiro atendimento da IA na conversa", async () => {
    const w = await marcioOwner();
    await claudivan(w);
    await q("insert into public.messages(organization_id,conversation_id,role,content,created_at,evolution_message_id) values ($1,$2,'human_agent','meses atrás',$3,'wa-old')", [w.org, w.h.conversationId, inMinutes(-60 * 24 * 90)]);
    expect(await escalate(w.id)).toBeTruthy();
  });

  it("não protege: mensagem da época de OUTRO vendedor (antes de o dono atual assumir)", async () => {
    const w = await marcioOwner();
    await claudivan(w, undefined, -60 * 50); // a Marina falou quando o lead era dela
    expect(await escalate(w.id)).toBeTruthy();
  });

  it("não protege: envio que falhou (sem id do WhatsApp, ou marcado send_failed_at)", async () => {
    const semId = await marcioOwner();
    await claudivan(semId, { at: -60 * 30, id: null });
    expect(await escalate(semId.id)).toBeTruthy();
    const falhou = await marcioOwner();
    await claudivan(falhou, { at: -60 * 30, id: "wa-2", meta: { send_failed_at: "2026-11-18T12:00:00Z" } });
    expect(await escalate(falhou.id)).toBeTruthy();
  });

  it("não protege: mensagem da IA ou do cliente no período do vendedor", async () => {
    const w = await marcioOwner();
    await claudivan(w, { at: -60 * 30, id: "wa-3", role: "agent" });
    expect(await escalate(w.id)).toBeTruthy();
  });

  it("atribuição manual continua só olhando as mensagens humanas depois da atribuição", async () => {
    const { org, def, reps, h } = await breached(ON, THREE, "Marina", 60);
    await q("insert into public.handoff_events(organization_id,conversation_id,handed_at) values ($1,$2,$3)", [org, h.conversationId, inMinutes(-60 * 24)]);
    await q("insert into public.messages(organization_id,conversation_id,role,content,created_at,evolution_message_id) values ($1,$2,'human_agent','conversa do vendedor anterior',$3,'wa-prev')", [org, h.conversationId, inMinutes(-60 * 23)]);
    const manual = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [org, h.conversationId, reps["Márcio"].repId, def, inMinutes(-70)]))[0].id;
    expect(await escalate(manual)).toBeTruthy();
  });

  it("aceite pelo botão Assumir (sem mensagem) não vale como resposta; aceite pela primeira mensagem vale", async () => {
    const w = await breached();
    await q("update public.lead_assignments set accepted_at=now(), accepted_via='button' where id=$1", [w.id]);
    expect(await escalate(w.id)).toBeTruthy();
    const w2 = await breached();
    await q("update public.lead_assignments set accepted_at=now(), accepted_via='first_message' where id=$1", [w2.id]);
    expect(await escalate(w2.id)).toBeNull();
  });

  // Sequência real: Márcio atende -> Marina recebe -> o gestor DEVOLVE ao Márcio (manual). Cada helper usa as funções reais do rodízio.
  async function sequencia(opts: { attend: "mensagem" | "assumir" | "mensagem-com-falha" | "nada" }) {
    const w = await seedWorld(db, ON, THREE);
    const h = await seedLead(db, w.org, { assignedTo: w.reps["Márcio"].userId, handedAt: inMinutes(-300) });
    const first = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(60)]))[0].id as string;
    expect((await row(first)).rep_id).toBe(w.reps["Márcio"].repId);
    if (opts.attend === "mensagem" || opts.attend === "mensagem-com-falha") {
      const meta = opts.attend === "mensagem-com-falha" ? JSON.stringify({ send_failed_at: "2026-11-18T12:00:00Z" }) : "{}";
      await q("insert into public.messages(organization_id,conversation_id,role,content,evolution_message_id,metadata) values ($1,$2,'human_agent','bom dia, me manda seu CPF','wa-seq',$3::jsonb)", [w.org, h.conversationId, meta]);
      await q("select public.record_human_message($1,$2,now(),$3,'panel')", [w.org, h.conversationId, w.reps["Márcio"].userId]);
    }
    if (opts.attend === "assumir") expect(await q("select public.accept_assignment($1,$2,false) as ok", [first, w.reps["Márcio"].userId])).toEqual([{ ok: true }]);
    const toMarina = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [w.org, h.conversationId, w.reps["Marina"].repId, w.def, inMinutes(60)]))[0].id as string;
    const back = async (due = -70) => (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [w.org, h.conversationId, w.reps["Márcio"].repId, w.def, inMinutes(due)]))[0].id as string;
    return { w, h, first, toMarina, back };
  }

  it("devolução manual ao vendedor com atendimento comprovado: o SLA cobra, mas a escalada não tira o cliente dele de novo", async () => {
    const { w, h, back } = await sequencia({ attend: "mensagem" });
    const ret = await back();
    expect(await row(ret)).toMatchObject({ reason: "manual", rep_id: w.reps["Márcio"].repId, status: "pending", sla_action: "alert" });
    // cobrança: o prazo vencido marca o atraso (alerta/cutucar)...
    expect((await q("select public.flag_sla_alerts() as n"))[0].n).toBeGreaterThanOrEqual(1);
    expect((await row(ret)).sla_breached).toBe(true);
    // ...mas nem a função nem a fila de candidatas movem o cliente
    expect(await escalate(ret)).toBeNull();
    expect(await q("select id from public.list_escalation_candidates(50) where id=$1", [ret])).toHaveLength(0);
    expect((await row(ret)).status).toBe("pending");
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBe(w.reps["Márcio"].userId);
  });

  it("Assumir sozinho não vale como atendimento: sem mensagem, a devolução manual continua escalável", async () => {
    const { back } = await sequencia({ attend: "assumir" });
    const ret = await back();
    expect(await escalate(ret)).toBeTruthy();
  });

  it("sem nenhum atendimento anterior, ou com envio que falhou, a devolução manual não protege", async () => {
    const nada = await sequencia({ attend: "nada" });
    expect(await escalate(await nada.back())).toBeTruthy();
    const falhou = await sequencia({ attend: "mensagem-com-falha" });
    expect(await escalate(await falhou.back())).toBeTruthy();
  });

  it("troca manual deliberada para OUTRO vendedor continua possível, e o histórico do Márcio não protege o novo", async () => {
    const { w, h } = await sequencia({ attend: "mensagem" });
    const toPaulo = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [w.org, h.conversationId, w.reps["Paulo"].repId, w.def, inMinutes(-70)]))[0].id as string;
    expect(await row(toPaulo)).toMatchObject({ reason: "manual", rep_id: w.reps["Paulo"].repId, status: "pending" });
    expect((await q("select assigned_to from public.conversations where id=$1", [h.conversationId]))[0].assigned_to).toBe(w.reps["Paulo"].userId);
    // sem atendimento comprovado DELE: não está "atendido" (todos os vendedores já passaram pela cadeia, então a escalada não tem para quem ir)
    expect((await q("select public._alert_assignment_answered(x) as a from public.lead_assignments x where x.id=$1", [toPaulo]))[0].a).toBe(false);
  });

  it("rodízio ('redistribute') e exceção não são tocados por esta função", async () => {
    const w = await seedWorld(db, ON, THREE);
    const h = await seedLead(db, w.org, { handedAt: inMinutes(-130) });
    const rr = (await q("select public.distribute_lead($1,$2,$3,$4,'{}'::jsonb) as id", [w.org, h.conversationId, h.handoffId, inMinutes(-70)]))[0].id;
    expect((await row(rr)).sla_action).toBe("redistribute");
    expect(await escalate(rr)).toBeNull();
  });

  it("sem outro vendedor (dono é o único): mantém a atribuição, deixa rastro e não cria linha extra; quando surge alguém, escala", async () => {
    const w = await breached(ON, [["Marina", 1]]);
    expect(await escalate(w.id)).toBeNull();
    expect(await escalate(w.id)).toBeNull(); // idempotente
    expect(await row(w.id)).toMatchObject({ status: "pending", redistribution_reason: "sla_escalation_no_rep", next_assignment_id: null });
    expect(await q("select id from public.lead_assignments where conversation_id=$1", [w.h.conversationId])).toHaveLength(1);
    expect((await q("select assigned_to from public.conversations where id=$1", [w.h.conversationId]))[0].assigned_to).toBe(w.reps["Marina"].userId);
    // aparece o Márcio
    const { seedRep } = await import("./harness.js");
    const marcio = await seedRep(db, w.org, "Márcio", 2);
    await q("insert into auth.users(id) values ($1)", [marcio.userId]);
    const nid = await escalate(w.id);
    expect((await row(nid!)).rep_id).toBe(marcio.repId);
    expect(await row(w.id)).toMatchObject({ status: "redistributed", redistribution_reason: "sla_escalation" });
  });

  it("vendedores indisponíveis (fora, pausado, sem ser membro, de outra organização) são pulados; sem nenhum elegível, fica", async () => {
    const w = await breached(ON, [["Marina", 1], ["Márcio", 2, "out"], ["Paulo", 3, "paused"]]);
    const { seedRep } = await import("./harness.js");
    await seedRep(db, w.org, "Ex-membro", 4, "available", false);
    const outsider = await seedWorld(db, ON, [["Estranho", 1]]);
    expect(outsider.reps["Estranho"]).toBeTruthy();
    expect(await escalate(w.id)).toBeNull();
    expect((await row(w.id)).status).toBe("pending");
    await q("update public.sales_reps set availability='available' where organization_id=$1 and display_name='Paulo'", [w.org]);
    const nid = await escalate(w.id);
    expect((await row(nid!)).rep_id).toBe(w.reps["Paulo"].repId);
  });

  it("próximo na ordem do rodízio depois do dono, com volta ao início", async () => {
    const mid = await breached(ON, THREE, "Márcio");
    expect((await row((await escalate(mid.id))!)).rep_id).toBe(mid.reps["Paulo"].repId);
    const last = await breached(ON, THREE, "Paulo");
    expect((await row((await escalate(last.id))!)).rep_id).toBe(last.reps["Marina"].repId);
  });

  it("no máximo UMA escalada por cadeia: a nova atribuição vencida não escala de novo, nem uma atribuição manual posterior", async () => {
    const w = await breached();
    const second = (await escalate(w.id))!;
    // a nova linha 'alert' também vence (o guarda de imutabilidade é desligado só neste teste para envelhecer o prazo)
    await q("alter table public.lead_assignments disable trigger lead_assignments_guard_update");
    await q("update public.lead_assignments set sla_due_at = now() - interval '5 minutes' where id=$1", [second]);
    await q("alter table public.lead_assignments enable trigger lead_assignments_guard_update");
    expect((await row(second)).status).toBe("pending");
    expect(await escalate(second)).toBeNull(); // vencida e sem resposta, mas a cadeia já foi escalada
    // gestor reatribui manualmente depois; a cadeia continua marcada como escalada
    const manual = (await q("select public.manual_assign($1,$2,$3,$4,$5) as id", [w.org, w.h.conversationId, w.reps["Paulo"].repId, w.def, inMinutes(-70)]))[0].id;
    expect(await escalate(manual)).toBeNull();
    expect(await q("select id from public.lead_assignments where chain_id=(select chain_id from public.lead_assignments where id=$1) and redistribution_reason='sla_escalation'", [w.id])).toHaveLength(1);
  });

  it("idempotência/corrida: duas chamadas seguidas criam uma única nova atribuição; a segunda devolve NULL", async () => {
    const w = await breached();
    const [first, second] = [await escalate(w.id), await escalate(w.id)];
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(await q("select id from public.lead_assignments where conversation_id=$1 and status in ('pending','accepted')", [w.h.conversationId])).toHaveLength(1);
    expect(await q("select id from public.lead_assignments where conversation_id=$1", [w.h.conversationId])).toHaveLength(2);
  });

  it("atribuição inexistente, já aceita ou já redistribuída => NULL", async () => {
    expect(await escalate("00000000-0000-0000-0000-000000000000")).toBeNull();
    const w = await breached();
    await q("update public.lead_assignments set status='accepted', accepted_at=now() where id=$1", [w.id]);
    expect(await escalate(w.id)).toBeNull();
  });

  it("linha anterior à ativação da distribuição não é movida", async () => {
    const w = await breached();
    await q("update public.organizations set settings = settings || jsonb_build_object('lead_distribution_activated_at', $2::text) where id=$1", [w.org, inMinutes(10)]);
    expect(await escalate(w.id)).toBeNull();
    expect((await row(w.id)).status).toBe("pending");
  });

  it("negócio do cliente: o card existente muda de dono uma só vez (sem criar outro) e vale o evento de dono", async () => {
    const w = await breached();
    const opp = (await row(w.id)).opportunity_id;
    expect(opp).toBeTruthy();
    await escalate(w.id);
    expect(await q("select id from public.opportunities where contact_id=$1", [w.h.contactId])).toHaveLength(1);
    const owners = await q("select new_value->>'owner_id' as o from public.opportunity_events where opportunity_id=$1 and event_type='owner_changed'", [opp]);
    expect(owners.map(r => r.o)).toEqual([w.reps["Márcio"].userId]);
  });

  it("somente service_role executa (anon/authenticated sem acesso)", async () => {
    const r = (await q("select has_function_privilege('authenticated','public.escalate_alert_assignment(uuid,timestamptz,timestamptz)','execute') as a, has_function_privilege('anon','public.escalate_alert_assignment(uuid,timestamptz,timestamptz)','execute') as n, has_function_privilege('service_role','public.escalate_alert_assignment(uuid,timestamptz,timestamptz)','execute') as s"))[0];
    expect(r).toEqual({ a: false, n: false, s: true });
  });
});
