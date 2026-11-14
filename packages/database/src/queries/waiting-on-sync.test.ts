import { describe, expect, it, vi } from "vitest";

const getOrg = vi.fn();
vi.mock("./organizations.js", () => ({ getOrganizationById: (...a: unknown[]) => getOrg(...a) }));
import { syncWaitingOnAfterCustomerReply, syncWaitingOnAfterHumanCompletion, syncWaitingOnAfterSellerMessage } from "./waiting-on-sync.js";
import { AWAITING_CUSTOMER_NEXT_ACTION, CUSTOMER_DECLINED_NEXT_ACTION, CUSTOMER_REPLIED_NEXT_ACTION, HANDOFF_AUTO_NEXT_ACTION, SELLER_PROMISED_NEXT_ACTION } from "@aula-agente/shared";

type Row = Record<string, any>;
/** Banco em memória com o subconjunto do supabase-js que o serviço usa (estado real: update/insert alteram as tabelas). */
function fakeDb(seed: { opportunities?: Row[]; tasks?: Row[]; messages?: Row[]; failTable?: string }) {
  const t: Record<string, Row[]> = { opportunities: seed.opportunities ?? [], tasks: seed.tasks ?? [], messages: seed.messages ?? [], opportunity_events: [], waiting_on_sync_shadow: [] };
  const calls: Array<{ table: string; op: string; payload?: any; filters?: any[] }> = [];
  const db: any = { from: (name: string) => {
    const filters: Array<(r: Row) => boolean> = []; const raw: any[] = []; let mode: "select" | "update" | "insert" = "select"; let payload: any; let lim = Infinity; let ord: [string, boolean] | null = null; let wantRows = false;
    const rows = () => { let r = t[name].filter((x) => filters.every((f) => f(x))); if (ord) r = [...r].sort((a, b) => (a[ord![0]] < b[ord![0]] ? -1 : 1) * (ord![1] ? 1 : -1)); return r.slice(0, lim); };
    const run = () => {
      if (seed.failTable === name) return { data: null, error: { message: "boom", code: "XX000" } };
      if (mode === "insert") { t[name] = t[name] ?? []; t[name].push({ id: `${name}-${t[name].length + 1}`, ...payload }); calls.push({ table: name, op: "insert", payload }); return { data: null, error: null }; }
      if (mode === "update") { const m = rows(); m.forEach((x) => Object.assign(x, payload)); calls.push({ table: name, op: "update", payload, filters: raw }); return { data: wantRows ? m : null, error: null }; }
      return { data: rows().map((x) => ({ ...x })), error: null }; // cópias, como o PostgREST
    };
    const b: any = {
      select: () => { if (mode === "update") wantRows = true; return b; },
      eq: (k: string, v: unknown) => (raw.push([k, v]), filters.push((r) => (r[k] ?? null) === (v ?? null)), b),
      neq: (k: string, v: unknown) => (filters.push((r) => r[k] !== v), b),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), b),
      gt: (k: string, v: any) => (filters.push((r) => r[k] > v), b),
      or: (expr: string) => { const parts = expr.split(",").map((p) => p.split(".")); filters.push((r) => parts.some(([k, , v]) => r[k] === v)); return b; },
      order: (k: string, o?: { ascending?: boolean }) => (ord = [k, o?.ascending !== false], b),
      limit: (n: number) => (lim = n, b),
      update: (p: any) => (mode = "update", payload = p, b),
      insert: (p: any) => (mode = "insert", payload = p, b),
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  } };
  return { db, t, calls };
}

const setMode = (settings: Record<string, unknown>) => { getOrg.mockReset(); getOrg.mockResolvedValue({ settings }); };
const ON = { waiting_on_sync_mode: "on" };
const opp = (over: Row = {}): Row => ({ organization_id: "org", id: "op1", contact_id: "ct1", status: "open", stage: "decision_negotiation", waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION, frozen_until: null, waiting_on_until: null, ...over });
const task = (over: Row = {}): any => ({ id: "t1", organization_id: "org", contact_id: "ct1", conversation_id: "conv1", opportunity_id: "op1", type: "return_customer", created_at: "2026-11-13T19:02:36Z", consolidated_pendencies: [], ...over });
const hm = (over: Row = {}) => ({ id: "m1", organization_id: "org", conversation_id: "conv1", role: "human_agent", created_at: "2026-11-13T19:30:00Z", ...over });
const REPLIED = { waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION };
const AWAIT = { waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION };

describe("syncWaitingOnAfterHumanCompletion", () => {
  it("caso Romario: concluiu o atendimento do repasse e respondeu => 'aguardando cliente', com guarda otimista e evento waiting_on_changed (origem, motivo, antes e depois)", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp()], messages: [hm()] });
    expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("set_customer");
    expect(w.t.opportunities[0]).toMatchObject(AWAIT);
    const upd = w.calls.find((c) => c.op === "update")!;
    expect(upd.filters).toEqual(expect.arrayContaining([["id", "op1"], ["waiting_on", "team"], ["next_action", HANDOFF_AUTO_NEXT_ACTION]]));
    expect(w.t.opportunity_events).toHaveLength(1);
    expect(w.t.opportunity_events[0]).toMatchObject({
      organization_id: "org", opportunity_id: "op1", event_type: "waiting_on_changed", changed_by_type: "system",
      previous_value: { waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION }, new_value: AWAIT,
    });
    expect(w.t.opportunity_events[0].evidence).toMatch(/origem=task_completed; regra=attendance_completed; motivo=.+; tarefa=t1/);
  });
  it.each([false, "true", 1, undefined])("modo antigo: só liga com waiting_on_sync_enabled === true literal (%s)", async (v) => {
    setMode({ waiting_on_sync_enabled: v }); const w = fakeDb({ opportunities: [opp()], messages: [hm()] });
    expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("disabled"); expect(w.calls).toHaveLength(0);
  });
  it("flag antiga (waiting_on_sync_enabled=true) continua equivalendo a 'on'", async () => {
    setMode({ waiting_on_sync_enabled: true }); const w = fakeDb({ opportunities: [opp()], messages: [hm()] });
    expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("set_customer");
  });
  it("concluiu sem ter respondido, ou sem conversa: não muda", async () => {
    setMode(ON);
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp()], messages: [] }).db, task())).toBe("no_human_reply");
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp()], messages: [hm()] }).db, task({ conversation_id: null }))).toBe("no_human_reply");
  });
  it("o cliente está esperando (última mensagem é dele): não vira 'aguardando cliente'", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp()], messages: [hm(), hm({ id: "m2", role: "contact", created_at: "2026-11-13T19:40:00Z" })] });
    expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("customer_waiting"); expect(w.t.opportunities[0].waiting_on).toBe("team");
  });
  it("outra obrigação da equipe aberta (simulação, documentos, retorno agendado): não muda; alerta de silêncio não impede", async () => {
    setMode(ON);
    const blocked = fakeDb({ opportunities: [opp()], messages: [hm()], tasks: [{ id: "t2", organization_id: "org", opportunity_id: "op1", contact_id: "ct1", status: "pending", type: "run_quote", consolidated_pendencies: [] }] });
    expect(await syncWaitingOnAfterHumanCompletion(blocked.db, task())).toBe("other_open_tasks");
    const silence = fakeDb({ opportunities: [opp()], messages: [hm()], tasks: [{ id: "t3", organization_id: "org", opportunity_id: "op1", contact_id: "ct1", status: "pending", type: "customer_nudge", consolidated_pendencies: [{ type: "customer_nudge" }] }] });
    expect(await syncWaitingOnAfterHumanCompletion(silence.db, task())).toBe("set_customer");
  });
  it("não era a tarefa de atendimento: não muda; consolidada que a carrega: muda", async () => {
    setMode(ON);
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp()], messages: [hm()] }).db, task({ type: "request_documents" }))).toBe("not_attendance_task");
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp()], messages: [hm()] }).db, task({ type: "customer_nudge", consolidated_pendencies: [{ type: "return_customer" }] }))).toBe("set_customer");
  });
  it("vários negócios abertos e tarefa sem negócio: não adivinha", async () => {
    setMode(ON);
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp(), opp({ id: "b" })], messages: [hm()] }).db, task({ opportunity_id: null }))).toBe("no_single_open_opportunity");
  });
  it("próxima ação editada, etapa da equipe, congelado e data combinada futura: não muda", async () => {
    setMode(ON);
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp({ next_action: "Ligar amanhã" })], messages: [hm()] }).db, task())).toBe("next_action_edited");
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp({ stage: "awaiting_simulation" })], messages: [hm()] }).db, task())).toBe("team_owned_stage");
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp({ frozen_until: "2099-01-01" })], messages: [hm()] }).db, task())).toBe("frozen");
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp({ waiting_on_until: "2099-01-01" })], messages: [hm()] }).db, task())).toBe("scheduled_date_pending");
  });
  it("alguém mexeu no negócio entre a leitura e a escrita: a edição vence (0 linhas) e nenhum evento é gravado", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp()], messages: [hm()] });
    const orig = w.db.from; let first = true;
    w.db.from = (n: string) => { const b = orig(n); if (n === "opportunities" && !first) { /* update */ } return b; };
    // simula a corrida: o humano troca a próxima ação logo depois da leitura (antes do update)
    const realFrom = w.db.from; let reads = 0;
    w.db.from = (n: string) => { const b = realFrom(n); if (n === "opportunities") { reads++; if (reads === 2) w.t.opportunities[0].next_action = "Ligar amanhã"; } return b; };
    first = false;
    expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("changed_meanwhile");
    expect(w.t.opportunities[0].next_action).toBe("Ligar amanhã"); expect(w.t.opportunity_events).toHaveLength(0);
  });
  it("erro de banco nunca lança (a conclusão da tarefa é a operação principal)", async () => {
    setMode(ON); const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await syncWaitingOnAfterHumanCompletion(fakeDb({ opportunities: [opp()], failTable: "opportunities" }).db, task())).toBe("error"); spy.mockRestore();
  });
  it("falha só no evento: a mudança fica e o erro é registrado (não derruba)", async () => {
    setMode(ON); const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const w = fakeDb({ opportunities: [opp()], messages: [hm()], failTable: "opportunity_events" });
    expect(await syncWaitingOnAfterHumanCompletion(w.db, task())).toBe("set_customer"); expect(w.t.opportunities[0]).toMatchObject(AWAIT); expect(spy).toHaveBeenCalled(); spy.mockRestore();
  });
});

describe("syncWaitingOnAfterCustomerReply", () => {
  const waiting = () => [opp(AWAIT)];
  const reply = (content: string | null, over: Row = {}) => ({ organizationId: "org", contactId: "ct1", role: "contact", content, messageId: "mc1", ...over });
  it("resposta devolve a bola à equipe, com guarda otimista e evento", async () => {
    setMode(ON); const w = fakeDb({ opportunities: waiting() });
    expect(await syncWaitingOnAfterCustomerReply(w.db, reply("Pode ser, qual o valor da entrada?"))).toBe("set_team");
    expect(w.t.opportunities[0]).toMatchObject(REPLIED);
    expect(w.calls.find((c) => c.op === "update")!.filters).toEqual(expect.arrayContaining([["waiting_on", "customer"], ["next_action", AWAITING_CUSTOMER_NEXT_ACTION]]));
    expect(w.t.opportunity_events[0].evidence).toContain("origem=customer_message; regra=customer_replied");
    expect(w.t.opportunity_events[0].evidence).toContain("mensagem=mc1");
  });
  it("'Não' é resposta: vai para a equipe com texto e regra próprios (sem presumir interesse)", async () => {
    setMode(ON); const w = fakeDb({ opportunities: waiting() });
    expect(await syncWaitingOnAfterCustomerReply(w.db, reply("Não"))).toBe("set_team");
    expect(w.t.opportunities[0]).toMatchObject({ waiting_on: "team", next_action: CUSTOMER_DECLINED_NEXT_ACTION });
    expect(w.t.opportunity_events[0].evidence).toContain("regra=customer_declined");
  });
  it("'Não tenho o RG aqui' é resposta comum (não recusa)", async () => {
    setMode(ON); const w = fakeDb({ opportunities: waiting() });
    await syncWaitingOnAfterCustomerReply(w.db, reply("Não tenho o RG aqui")); expect(w.t.opportunities[0].next_action).toBe(CUSTOMER_REPLIED_NEXT_ACTION);
  });
  it("áudio do cliente (sem transcrição) conta como resposta", async () => {
    setMode(ON); const w = fakeDb({ opportunities: waiting() });
    expect(await syncWaitingOnAfterCustomerReply(w.db, reply(null, { mediaType: "audio" }))).toBe("set_team");
  });
  it("'ok' ou mensagem do vendedor não transfere nada; contexto de anúncio também não", async () => {
    setMode(ON);
    const a = fakeDb({ opportunities: waiting() }); expect(await syncWaitingOnAfterCustomerReply(a.db, reply("ok"))).toBe("not_substantive"); expect(a.calls).toHaveLength(0);
    const b = fakeDb({ opportunities: waiting() }); expect(await syncWaitingOnAfterCustomerReply(b.db, reply("quero fechar sim", { role: "human_agent" }))).toBe("not_customer");
    const c = fakeDb({ opportunities: waiting() }); expect(await syncWaitingOnAfterCustomerReply(c.db, reply("[Cliente veio de um anúncio: Simule seu consórcio]"))).toBe("not_substantive");
  });
  it("'Aguardando cliente' definido manualmente nunca é desfeito", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp({ waiting_on: "customer", next_action: "Aguardar documentos" })] });
    expect(await syncWaitingOnAfterCustomerReply(w.db, reply("mandei os documentos agora, pode conferir?"))).toBe("not_auto_waiting"); expect(w.calls).toHaveLength(0);
  });
  it("modo off: nada", async () => {
    setMode({}); expect(await syncWaitingOnAfterCustomerReply(fakeDb({ opportunities: waiting() }).db, reply("qual o valor?"))).toBe("disabled");
  });
});

describe("syncWaitingOnAfterSellerMessage", () => {
  const seller = (content: string | null, over: Row = {}) => ({ organizationId: "org", contactId: "ct1", role: "human_agent", content, messageId: "ms1", ...over });
  it("proposta depois da resposta do cliente: volta para 'aguardando cliente' e grava o evento (o caso Romario)", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp(REPLIED)] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("consórcio 40.000   61 x 575,95  plano parcela reduzida"))).toBe("set_customer");
    expect(w.t.opportunities[0]).toMatchObject(AWAIT);
    expect(w.t.opportunity_events[0]).toMatchObject({ previous_value: REPLIED, new_value: AWAIT, changed_by_type: "system" });
    expect(w.t.opportunity_events[0].evidence).toContain("origem=seller_message; regra=seller_proposal");
  });
  it("não basta ser 'não trivial': mensagem longa sem proposta nem pergunta não muda", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp(REPLIED)] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("Estamos com várias opções disponíveis nesta semana na loja, passe quando puder"))).toBe("no_change");
    expect(w.calls).toHaveLength(0);
  });
  it("obrigações da equipe abertas (simulação, documentos, retorno agendado, financiamento) preservam o estado", async () => {
    setMode(ON);
    for (const type of ["run_quote", "update_quote", "request_documents", "scheduled_callback", "financing_followup", "awaiting_customer_data"]) {
      const w = fakeDb({ opportunities: [opp(REPLIED)], tasks: [{ id: "t9", organization_id: "org", opportunity_id: "op1", contact_id: "ct1", status: "pending", type, consolidated_pendencies: [] }] });
      expect(await syncWaitingOnAfterSellerMessage(w.db, seller("entrada R$ 8.000, 56x R$ 535")), type).toBe("other_open_tasks"); expect(w.t.opportunities[0].waiting_on).toBe("team");
    }
  });
  it("etapa da equipe, data combinada futura e congelado preservam o estado", async () => {
    setMode(ON);
    expect(await syncWaitingOnAfterSellerMessage(fakeDb({ opportunities: [opp({ ...REPLIED, stage: "bank_analysis" })] }).db, seller("entrada R$ 8.000, 56x"))).toBe("team_owned_stage");
    expect(await syncWaitingOnAfterSellerMessage(fakeDb({ opportunities: [opp({ ...REPLIED, waiting_on: "scheduled_date", waiting_on_until: "2099-01-01" })] }).db, seller("entrada R$ 8.000, 56x"))).toBe("scheduled_date_pending");
    expect(await syncWaitingOnAfterSellerMessage(fakeDb({ opportunities: [opp({ ...REPLIED, frozen_until: "2099-01-01" })] }).db, seller("entrada R$ 8.000, 56x"))).toBe("frozen");
  });
  it("edição humana nunca é sobrescrita (próxima ação com texto próprio)", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp({ waiting_on: "team", next_action: "Ligar amanhã às 10h" })] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("entrada R$ 8.000, 56x R$ 535"))).toBe("next_action_edited"); expect(w.calls).toHaveLength(0);
  });
  it("promessa de verificar: a bola é da equipe (texto próprio)", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp(AWAIT)] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("vou verificar com o gerente e já te retorno"))).toBe("set_team");
    expect(w.t.opportunities[0]).toMatchObject({ waiting_on: "team", next_action: SELLER_PROMISED_NEXT_ACTION });
  });
  it("depois de um 'não' do cliente nunca volta sozinho", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp({ waiting_on: "team", next_action: CUSTOMER_DECLINED_NEXT_ACTION })] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("e se eu baixar a entrada para R$ 6.000?"))).toBe("next_action_edited"); expect(w.calls).toHaveLength(0);
  });
  it("áudio do vendedor, cortesia e mensagem de IA não mudam nada nem consultam tarefas", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp(REPLIED)] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller(null, { mediaType: "audio" }))).toBe("no_change");
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("Bom dia"))).toBe("no_change");
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("entrada R$ 8.000, 56x", { role: "agent" }))).toBe("not_seller");
    expect(w.calls).toHaveLength(0);
  });
  it("documento/imagem do vendedor é proposta", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp(REPLIED)] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, seller("Segue a simulação", { mediaType: "document" }))).toBe("set_customer");
  });
  it("rajada com várias mensagens: cada uma é avaliada em ordem (proposta e depois 'vou verificar' termina na equipe)", async () => {
    setMode(ON); const w = fakeDb({ opportunities: [opp(REPLIED)] });
    await syncWaitingOnAfterSellerMessage(w.db, seller("entrada R$ 8.000, 56x R$ 535"));
    expect(w.t.opportunities[0].waiting_on).toBe("customer");
    await syncWaitingOnAfterSellerMessage(w.db, seller("vou verificar se tem opção menor"));
    expect(w.t.opportunities[0]).toMatchObject({ waiting_on: "team", next_action: SELLER_PROMISED_NEXT_ACTION });
    expect(w.t.opportunity_events).toHaveLength(2);
  });
  it("vários negócios abertos do contato: não adivinha", async () => {
    setMode(ON); expect(await syncWaitingOnAfterSellerMessage(fakeDb({ opportunities: [opp(REPLIED), opp({ ...REPLIED, id: "b" })] }).db, seller("entrada R$ 8.000, 56x"))).toBe("no_single_open_opportunity");
  });
});

describe("modo sombra: compara sem modificar nenhum negócio", () => {
  it("registra o que FARIA (regra, gatilho, valores) e não toca em opportunities nem em opportunity_events", async () => {
    setMode({ waiting_on_sync_mode: "shadow" }); const w = fakeDb({ opportunities: [opp(REPLIED)] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, { organizationId: "org", contactId: "ct1", role: "human_agent", content: "entrada R$ 8.000, 56x R$ 535", messageId: "ms1" })).toBe("shadow:seller_proposal");
    expect(w.t.opportunities[0]).toMatchObject(REPLIED); // intacto
    expect(w.t.opportunity_events).toHaveLength(0);
    expect(w.calls.some((c) => c.table === "opportunities" && c.op === "update")).toBe(false);
    expect(w.t.waiting_on_sync_shadow).toHaveLength(1);
    expect(w.t.waiting_on_sync_shadow[0]).toMatchObject({
      organization_id: "org", opportunity_id: "op1", rule: "seller_proposal", trigger: "seller_message",
      would_set: AWAIT, observed: { waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION, stage: "decision_negotiation" },
    });
  });
  it("vale para os três gatilhos", async () => {
    setMode({ waiting_on_sync_mode: "shadow" });
    const a = fakeDb({ opportunities: [opp()], messages: [hm()] }); expect(await syncWaitingOnAfterHumanCompletion(a.db, task())).toBe("shadow:attendance_completed");
    const b = fakeDb({ opportunities: [opp(AWAIT)] }); expect(await syncWaitingOnAfterCustomerReply(b.db, { organizationId: "org", contactId: "ct1", role: "contact", content: "Não" })).toBe("shadow:customer_declined");
    for (const w of [a, b]) { expect(w.t.opportunities[0].waiting_on).toBe(w === a ? "team" : "customer"); expect(w.t.opportunity_events).toHaveLength(0); }
  });
  it("sem a tabela (migração não aplicada): cai para log e continua sem tocar no negócio", async () => {
    setMode({ waiting_on_sync_mode: "shadow" }); const log = vi.spyOn(console, "log").mockImplementation(() => {}); const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = fakeDb({ opportunities: [opp(REPLIED)] });
    const real = w.db.from; w.db.from = (n: string) => n === "waiting_on_sync_shadow" ? { insert: () => Promise.resolve({ error: { code: "42P01", message: "relation does not exist" } }) } : real(n);
    expect(await syncWaitingOnAfterSellerMessage(w.db, { organizationId: "org", contactId: "ct1", role: "human_agent", content: "entrada R$ 8.000, 56x" })).toBe("shadow:seller_proposal");
    expect(w.t.opportunities[0]).toMatchObject(REPLIED); expect(log.mock.calls.some((c) => String(c[0]).startsWith("waiting-on-sync[shadow]"))).toBe(true);
    log.mockRestore(); warn.mockRestore();
  });
  it("as guardas valem igual no modo sombra (nada é registrado quando a regra não agiria)", async () => {
    setMode({ waiting_on_sync_mode: "shadow" }); const w = fakeDb({ opportunities: [opp({ waiting_on: "team", next_action: "Ligar amanhã" })] });
    expect(await syncWaitingOnAfterSellerMessage(w.db, { organizationId: "org", contactId: "ct1", role: "human_agent", content: "entrada R$ 8.000, 56x" })).toBe("next_action_edited");
    expect(w.t.waiting_on_sync_shadow).toHaveLength(0);
  });
});
