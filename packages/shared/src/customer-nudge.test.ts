import { describe, expect, it } from "vitest";
import { DEFAULT_BUSINESS_CALENDAR, type BusinessCalendar } from "./business-calendar.js";
import { buildCustomerNudgeTask, decideCustomerNudge, DIA_UTIL, type CustomerNudgeInput } from "./customer-nudge.js";

// Caso Erica: vendedora falou quinta 29/10/2026 14:55 (BRT = UTC-3); 31/10 sábado; 02/11 segunda (Finados).
const SENT = new Date("2026-10-29T17:55:00Z");
const base = (over: Partial<CustomerNudgeInput> = {}): CustomerNudgeInput => ({
  now: new Date("2026-10-30T18:00:00Z"), // sexta 15:00
  calendar: DEFAULT_BUSINESS_CALENDAR, lastSellerMessageAt: SENT, priorTouches: 0, ownerId: "u1", hasOpenTask: false, frozen: false,
  opportunity: { waiting_on: null, waiting_on_until: null }, todayISODate: "2026-10-30", customerClosing: false, ...over,
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
  it("cliente se despediu/agradeceu antes", () => expect(decideCustomerNudge(base({ customerClosing: true }))).toEqual(skip("closing_ack")));
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
