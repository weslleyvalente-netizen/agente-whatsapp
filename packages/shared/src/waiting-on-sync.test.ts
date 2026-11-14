import { describe, expect, it } from "vitest";
import { AWAITING_CUSTOMER_NEXT_ACTION, CUSTOMER_REPLIED_NEXT_ACTION, HANDOFF_AUTO_NEXT_ACTION, decideAttendanceCompleted, decideCustomerReplied } from "./waiting-on-sync.js";

const opp = (over = {}) => ({ status: "open", stage: "decision_negotiation", waiting_on: "team", next_action: HANDOFF_AUTO_NEXT_ACTION, ...over });
const base = (over = {}) => ({ opportunity: opp(), completedTypes: ["return_customer"], humanRepliedAfterTaskCreated: true, otherOpenTasks: 0, ...over });

describe("decideAttendanceCompleted (equipe -> cliente, só com prova)", () => {
  it("caso Romario: tarefa de atendimento concluída por humano, vendedora respondeu, nada mais aberto => cliente", () => {
    expect(decideAttendanceCompleted(base())).toEqual({ action: "set_customer", waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION });
  });
  it("tarefa consolidada que carrega return_customer entre as pendências também vale", () => {
    expect(decideAttendanceCompleted(base({ completedTypes: ["customer_nudge", "return_customer"] })).action).toBe("set_customer");
  });
  it.each([
    ["negócio fechado/perdido", { opportunity: opp({ status: "lost" }) }, "not_open"],
    ["aguardando banco, data combinada ou cliente já", { opportunity: opp({ waiting_on: "bank_or_admin" }) }, "not_waiting_team"],
    ["próxima ação editada por humano", { opportunity: opp({ next_action: "Ligar amanhã às 10h" }) }, "next_action_edited"],
    ["etapa da equipe (simulação)", { opportunity: opp({ stage: "awaiting_simulation" }) }, "team_owned_stage"],
    ["etapa da equipe (condições aprovadas)", { opportunity: opp({ stage: "conditions_approved_negotiation" }) }, "team_owned_stage"],
    ["tarefa concluída não era a de atendimento", { completedTypes: ["run_quote"] }, "not_attendance_task"],
    ["concluiu a tarefa sem responder o cliente (mensagem do vendedor não é pré-requisito presumido)", { humanRepliedAfterTaskCreated: false }, "no_human_reply"],
    ["ainda há outra obrigação aberta no negócio", { otherOpenTasks: 1 }, "other_open_tasks"],
  ])("não muda: %s", (_n, over, reason) => {
    expect(decideAttendanceCompleted(base(over))).toEqual({ action: "keep", reason });
  });
});

describe("decideCustomerReplied (cliente -> equipe, só do valor automático)", () => {
  const auto = { opportunity: opp({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION }), substantive: true };
  it("resposta substantiva devolve a bola à equipe", () => {
    expect(decideCustomerReplied(auto)).toEqual({ action: "set_team", waiting_on: "team", next_action: CUSTOMER_REPLIED_NEXT_ACTION });
  });
  it("'ok'/cortesia não transfere nada", () => expect(decideCustomerReplied({ ...auto, substantive: false })).toEqual({ action: "keep", reason: "not_substantive" }));
  it("'Aguardando cliente' escolhido por um humano (next_action diferente) nunca é desfeito", () => {
    expect(decideCustomerReplied({ ...auto, opportunity: opp({ waiting_on: "customer", next_action: "Aguardar documentos" }) })).toEqual({ action: "keep", reason: "not_auto_waiting" });
  });
  it("outros estados (equipe, banco, data combinada) ficam como estão", () => {
    for (const waiting_on of ["team", "bank_or_admin", "scheduled_date", null]) expect(decideCustomerReplied({ ...auto, opportunity: opp({ waiting_on }) }).action).toBe("keep");
  });
  it("negócio fechado fica como está", () => expect(decideCustomerReplied({ ...auto, opportunity: opp({ waiting_on: "customer", next_action: AWAITING_CUSTOMER_NEXT_ACTION, status: "won" }) }).action).toBe("keep"));
});
