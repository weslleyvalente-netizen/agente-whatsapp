import { describe, expect, it } from "vitest";
import type { SlaAlert } from "@aula-agente/shared";
import { nudgedAtLabel, slaAlertRow, summarizeNudgeAll } from "./sla-alert-view";

const now = new Date("2026-11-09T12:00:00Z");
const alert = (over: Partial<SlaAlert> = {}) => ({ id: "a1", rep_id: "r1", conversation_id: "conv 1", sla_due_at: "2026-11-09T09:30:00Z", assigned_at: "2026-11-09T08:30:00Z", contact_name: "Ana", contact_phone: "5511", ...over }) as SlaAlert;
const reps = [{ id: "r1", display_name: "Marina" }];

describe("slaAlertRow", () => {
  it("cliente, vendedor, venceu há X e link da conversa", () => {
    expect(slaAlertRow(alert(), reps, now)).toEqual({ id: "a1", client: "Ana", repName: "Marina", overdue: "venceu há 2 h", href: "/opportunities?conversa=conv%201" });
  });
  it("sem nome usa o telefone; @lid vira Contato sem telefone; vendedor desconhecido vira traço", () => {
    expect(slaAlertRow(alert({ contact_name: null }), reps, now).client).toBe("5511");
    expect(slaAlertRow(alert({ contact_name: null, contact_phone: "1@lid" }), reps, now).client).toBe("Contato sem telefone");
    expect(slaAlertRow(alert({ rep_id: "zz" }), reps, now).repName).toBe("—");
  });
  it("sem prazo usa a data da atribuição", () => {
    expect(slaAlertRow(alert({ sla_due_at: null }), reps, now).overdue).toBe("venceu há 3 h");
  });
});
describe("nudgedAtLabel", () => {
  it("HH:MM em Brasília", () => expect(nudgedAtLabel("2026-11-09T17:05:00Z")).toBe("Cutucado às 14:05"));
});
describe("summarizeNudgeAll", () => {
  it("resume cada situação", () => {
    expect(summarizeNudgeAll([])).toBe("Nenhum vendedor para avisar.");
    expect(summarizeNudgeAll([
      { repId: "1", repName: "Marina", count: 2, status: "sent" }, { repId: "2", repName: "Marcio", count: 1, status: "rate_limited", retryAfterMinutes: 30 },
      { repId: "3", repName: "Ze", count: 1, status: "no_device" }, { repId: "4", repName: "Lu", count: 1, status: "no_user" },
    ])).toBe("Aviso enviado para Marina. Marcio: já cutucado(s) há menos de 2 h. Ze: sem notificações ativadas. Lu: sem usuário vinculado.");
  });
});
