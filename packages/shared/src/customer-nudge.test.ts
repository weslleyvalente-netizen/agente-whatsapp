import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_CALENDAR, type BusinessCalendar } from "./business-calendar.js";
import { businessDayMinutes } from "./business-calendar.js";
import { buildCustomerNudgeTask, customerNudgeIntervalMinutes, customerNudgeLadderMinutes, decideCustomerNudge, DIA_UTIL, type CustomerNudgeInput } from "./customer-nudge.js";

// Caso Erica: vendedora falou quinta 29/10/2026 14:55 (BRT = UTC-3); 31/10 sábado; 02/11 segunda (Finados).
const SENT = new Date("2026-10-29T17:55:00Z");
const base = (over: Partial<CustomerNudgeInput> = {}): CustomerNudgeInput => ({
  now: new Date("2026-10-30T18:00:00Z"), // sexta 15:00
  calendar: DEFAULT_BUSINESS_CALENDAR, lastSellerMessageAt: SENT, priorTouches: 0, ownerId: "u1", hasOpenTask: false, frozen: false,
  opportunity: { waiting_on: null, waiting_on_until: null }, todayISODate: "2026-10-30", customerRefused: false, ...over,
});
const skip = (reason: string) => ({ action: "skip", reason });

describe("decideCustomerNudge: escada", () => {
  it("DIA_UTIL = 600", () => expect(DIA_UTIL).toBe(600));
  it("toque 1 só depois de 1 dia útil", () => {
    expect(decideCustomerNudge(base({ now: new Date("2026-10-30T17:54:00Z") }))).toEqual(skip("not_due_yet")); // sex 14:54
    expect(decideCustomerNudge(base({ now: new Date("2026-10-30T17:55:00Z") }))).toMatchObject({ action: "create", touch: 1, ladderDays: 1 });
  });
  it("não conta noite nem fim de semana: segunda cedo ainda é o toque 1, toque 2 só com 3 dias úteis", () => {
    const mon = new Date("2026-11-02T14:00:00Z"); // seg 11:00
    expect(decideCustomerNudge(base({ now: mon, priorTouches: 1 }))).toEqual(skip("not_due_yet"));
    const tue = new Date("2026-11-03T17:55:00Z"); // ter 14:55 = 3 dias úteis exatos
    expect(decideCustomerNudge(base({ now: new Date("2026-11-03T17:54:00Z"), priorTouches: 1 }))).toEqual(skip("not_due_yet"));
    expect(decideCustomerNudge(base({ now: tue, priorTouches: 1 }))).toMatchObject({ action: "create", touch: 2, ladderDays: 3 });
  });
  it("toque 3 com 7 dias úteis; depois disso para", () => {
    const sentMon = new Date("2026-11-02T11:00:00Z"); // seg 08:00
    expect(decideCustomerNudge(base({ lastSellerMessageAt: sentMon, now: new Date("2026-11-10T14:00:00Z"), priorTouches: 2 }))).toEqual(skip("not_due_yet"));
    expect(decideCustomerNudge(base({ lastSellerMessageAt: sentMon, now: new Date("2026-11-11T14:00:00Z"), priorTouches: 2, todayISODate: "2026-11-11" })))
      .toMatchObject({ action: "create", touch: 3, ladderDays: 7 });
    expect(decideCustomerNudge(base({ lastSellerMessageAt: sentMon, now: new Date("2026-11-12T14:00:00Z"), priorTouches: 3 }))).toEqual(skip("max_touches"));
  });
  it("feriado no calendário empurra o toque 2", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedDates: ["2026-11-02"] };
    expect(decideCustomerNudge(base({ calendar: cal, now: new Date("2026-11-03T17:55:00Z"), priorTouches: 1 }))).toEqual(skip("not_due_yet"));
    expect(decideCustomerNudge(base({ calendar: cal, now: new Date("2026-11-04T17:55:00Z"), priorTouches: 1, todayISODate: "2026-11-04" }))).toMatchObject({ action: "create", touch: 2 });
  });
});

describe("decideCustomerNudge: intervalo desde o toque anterior", () => {
  // Cliente parado há muito: vendedor falou seg 26/10 08:00; toque 1 concluído ter 03/11 08:20 (BRT).
  const sentLong = new Date("2026-10-26T11:00:00Z");
  const t1 = "2026-11-03T11:20:00Z";
  const at = (iso: string, over: Partial<CustomerNudgeInput> = {}) =>
    decideCustomerNudge(base({ lastSellerMessageAt: sentLong, now: new Date(iso), priorTouches: 1, lastNudgeAt: t1, todayISODate: iso.slice(0, 10), ...over }));
  it("toque 2 NÃO nasce logo depois de concluir o toque 1, mesmo com silêncio > 3 dias úteis", () => {
    expect(at("2026-11-03T11:50:00Z")).toEqual(skip("nudge_interval"));
    expect(at("2026-11-04T20:00:00Z")).toEqual(skip("nudge_interval")); // qua 17:00: 1 dia útil
  });
  it("toque 2 nasce 2 dias úteis depois do toque 1", () => {
    expect(at("2026-11-05T11:19:00Z")).toEqual(skip("nudge_interval")); // qui 08:19
    expect(at("2026-11-05T11:20:00Z")).toMatchObject({ action: "create", touch: 2, ladderDays: 3 });
  });
  it("toque 3 só depois de 4 dias úteis do toque 2", () => {
    const t2 = "2026-11-05T11:30:00Z"; // qui 08:30
    const c = (iso: string) => decideCustomerNudge(base({ lastSellerMessageAt: new Date("2026-10-28T14:00:00Z"), now: new Date(iso), priorTouches: 2, lastNudgeAt: t2, todayISODate: iso.slice(0, 10) }));
    expect(c("2026-11-09T14:00:00Z")).toEqual(skip("nudge_interval"));
    expect(c("2026-11-11T11:29:00Z")).toEqual(skip("nudge_interval")); // ter 08:29 = 3 dias úteis + 599 min
    expect(c("2026-11-11T11:30:00Z")).toMatchObject({ action: "create", touch: 3, ladderDays: 7 });
  });
  it("fim de semana e feriado não contam como úteis", () => {
    const cal: BusinessCalendar = { ...DEFAULT_BUSINESS_CALENDAR, closedDates: ["2026-11-05"] };
    expect(at("2026-11-06T11:19:00Z", { calendar: cal })).toEqual(skip("nudge_interval")); // quinta fechada não conta
    expect(at("2026-11-06T11:20:00Z", { calendar: cal })).toMatchObject({ action: "create", touch: 2 });
    // toque na sexta 15:00: sábado e domingo não contam => 2 dias úteis só na terça 15:00 (segunda é útil no calendário padrão)
    const fri = "2026-10-30T18:00:00Z";
    expect(at("2026-11-03T17:59:00Z", { lastNudgeAt: fri })).toEqual(skip("nudge_interval"));
    expect(at("2026-11-03T18:00:00Z", { lastNudgeAt: fri })).toMatchObject({ action: "create", touch: 2 });
  });
  it("sem toque anterior o comportamento não muda (lastNudgeAt ausente ou null)", () => {
    expect(decideCustomerNudge(base())).toMatchObject({ action: "create", touch: 1 });
    expect(decideCustomerNudge(base({ lastNudgeAt: null }))).toMatchObject({ action: "create", touch: 1 });
  });
  it("cliente que respondeu zera o ciclo (priorTouches 0, sem intervalo)", () => {
    expect(decideCustomerNudge(base({ priorTouches: 0, lastNudgeAt: null }))).toMatchObject({ action: "create", touch: 1 });
  });
});

describe("decideCustomerNudge: quando não cria", () => {
  it("sem dono", () => expect(decideCustomerNudge(base({ ownerId: null }))).toEqual(skip("no_owner")));
  it("mensagem do vendedor com mais de 14 dias", () => {
    expect(decideCustomerNudge(base({ now: new Date("2026-11-13T18:00:00Z") }))).toEqual(skip("too_old")); // 15 dias depois
  });
  it("fora do expediente (noite e fim de semana)", () => {
    expect(decideCustomerNudge(base({ now: new Date("2026-10-30T22:00:00Z") }))).toEqual(skip("outside_business_hours")); // sex 19:00
    expect(decideCustomerNudge(base({ now: new Date("2026-10-31T15:00:00Z") }))).toEqual(skip("outside_business_hours")); // sáb
  });
  it("tarefa de cutucar já aberta", () => expect(decideCustomerNudge(base({ hasOpenTask: true }))).toEqual(skip("open_task")));
  it("contato congelado", () => expect(decideCustomerNudge(base({ frozen: true }))).toEqual(skip("frozen")));
  it("retorno combinado no futuro", () => {
    expect(decideCustomerNudge(base({ opportunity: { waiting_on: "scheduled_date", waiting_on_until: "2026-11-05" } }))).toEqual(skip("waiting_scheduled"));
    // data já chegou: volta a valer
    expect(decideCustomerNudge(base({ opportunity: { waiting_on: "scheduled_date", waiting_on_until: "2026-10-30" } }))).toMatchObject({ action: "create" });
  });
  it("pendência nossa (equipe ou banco)", () => {
    expect(decideCustomerNudge(base({ opportunity: { waiting_on: "team", waiting_on_until: null } }))).toEqual(skip("waiting_on_us"));
    expect(decideCustomerNudge(base({ opportunity: { waiting_on: "bank_or_admin", waiting_on_until: null } }))).toEqual(skip("waiting_on_us"));
    expect(decideCustomerNudge(base({ opportunity: { waiting_on: "customer", waiting_on_until: null } }))).toMatchObject({ action: "create" });
  });
  it("cliente recusou explicitamente antes", () => expect(decideCustomerNudge(base({ customerRefused: true }))).toEqual(skip("customer_refused")));
});

describe("buildCustomerNudgeTask", () => {
  it("toques 1 e 2: prioridade normal e texto padrão", () => {
    const t = buildCustomerNudgeTask(1, 1);
    expect(t.priority).toBe("normal");
    expect(t.description).toBe("Cliente parou de responder há 1 dia útil depois da sua última mensagem. Retome a conversa (toque 1 de 3).");
    expect(buildCustomerNudgeTask(2, 3).description).toContain("há 3 dias úteis");
  });
  it("toque 3: prioridade alta e sugere encerrar", () => {
    const t = buildCustomerNudgeTask(3, 7);
    expect(t.priority).toBe("high");
    expect(t.description).toContain("toque 3 de 3");
    expect(t.description).toContain("Se não houver retorno, considere encerrar ou marcar o negócio como perdido.");
  });
});

// Calendário REAL da Moto e Trilha: seg–sex 07:30–18:00 (630 min), sábado 08:00–12:00.
const MOTO: BusinessCalendar = {
  timeZone: "America/Sao_Paulo", closedDates: ["2026-11-20"], closedPeriods: [],
  weekly: { mon: [{ start: "07:30", end: "18:00" }], tue: [{ start: "07:30", end: "18:00" }], wed: [{ start: "07:30", end: "18:00" }], thu: [{ start: "07:30", end: "18:00" }], fri: [{ start: "07:30", end: "18:00" }], sat: [{ start: "08:00", end: "12:00" }] },
};

describe("calendário real da organização (dia útil = o dia mais longo do calendário, não 600 fixos)", () => {
  it("businessDayMinutes: padrão 600; Moto e Trilha 630", () => {
    expect(businessDayMinutes(DEFAULT_BUSINESS_CALENDAR)).toBe(600); expect(businessDayMinutes(MOTO)).toBe(630);
  });
  it("escada e intervalo escalam com o calendário", () => {
    expect(customerNudgeLadderMinutes(MOTO)).toEqual([630, 1890, 4410]); expect(customerNudgeIntervalMinutes(MOTO)).toEqual([0, 1260, 2520]);
    expect(customerNudgeLadderMinutes(DEFAULT_BUSINESS_CALENDAR)).toEqual([600, 1800, 4200]);
  });
  const sentRomario = new Date("2026-11-13T20:33:58.791Z"); // sexta 17:33 BRT
  const romario = (iso: string) => decideCustomerNudge(base({ calendar: MOTO, lastSellerMessageAt: sentRomario, now: new Date(iso), todayISODate: iso.slice(0, 10) }));
  it("caso Romario: sexta 17:33 BRT (27 min na sexta + 240 min no sábado + 363 na segunda) => toque 1 vence segunda 16/11 13:34 BRT", () => {
    expect(romario("2026-11-14T14:00:00Z")).toEqual(skip("not_due_yet")); // sábado 11:00 BRT, aberto mas ainda não venceu
    expect(romario("2026-11-16T16:33:00Z")).toEqual(skip("not_due_yet"));
    expect(romario("2026-11-16T16:34:00Z")).toMatchObject({ action: "create", touch: 1 });
  });
  it("domingo e fora do expediente: nunca cria", () => {
    expect(romario("2026-11-15T15:00:00Z")).toEqual(skip("outside_business_hours")); // domingo
    expect(romario("2026-11-14T16:00:00Z")).toEqual(skip("outside_business_hours")); // sábado 13:00 BRT, após o fechamento
  });
  it("feriado do calendário (sexta 20/11) empurra o prazo: quinta 17:00 BRT => segunda 23/11 13:00 BRT", () => {
    const sent = new Date("2026-11-19T20:00:00Z");
    const d = (iso: string) => decideCustomerNudge(base({ calendar: MOTO, lastSellerMessageAt: sent, now: new Date(iso), todayISODate: iso.slice(0, 10) }));
    expect(d("2026-11-20T15:00:00Z")).toEqual(skip("outside_business_hours")); // sexta fechada
    expect(d("2026-11-23T15:59:00Z")).toEqual(skip("not_due_yet"));
    expect(d("2026-11-23T16:00:00Z")).toMatchObject({ action: "create" });
  });
});

describe("linha de corte da ativação gradual (sem disparo retroativo)", () => {
  const sent = new Date("2026-10-29T17:55:00Z");
  it("mensagem do vendedor antes do corte: histórico, não cobra", () => {
    expect(decideCustomerNudge(base({ baselineAt: new Date("2026-10-30T00:00:00Z") }))).toEqual(skip("before_baseline"));
  });
  it("mensagem exatamente no corte ou depois: regra normal", () => {
    expect(decideCustomerNudge(base({ baselineAt: sent, now: new Date("2026-10-30T17:55:00Z") }))).toMatchObject({ action: "create" });
  });
  it("sem corte: regra normal", () => expect(decideCustomerNudge(base({ baselineAt: null }))).toMatchObject({ action: "create" }));
  it("o corte vem antes do 'too_old' (histórico antigo é explicado pelo corte)", () => {
    expect(decideCustomerNudge(base({ baselineAt: new Date("2026-11-30T00:00:00Z"), now: new Date("2026-11-20T18:00:00Z") }))).toEqual(skip("before_baseline"));
  });
});
