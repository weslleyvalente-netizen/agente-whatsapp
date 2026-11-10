import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlaAlert } from "@aula-agente/shared";
import { SlaAlertsSection, type SlaAlertsSectionProps } from "./sla-alerts-section";

const now = new Date("2026-11-09T12:00:00Z");
const mk = (id: string, name: string | null, phone = "5511"): SlaAlert => ({ id, rep_id: "r1", conversation_id: `c-${id}`, sla_due_at: "2026-11-09T09:30:00Z", assigned_at: "2026-11-09T08:00:00Z", contact_name: name, contact_phone: phone }) as SlaAlert;
const base = (over: Partial<SlaAlertsSectionProps> = {}): SlaAlertsSectionProps => ({
  alerts: [mk("a", "Ana Souza"), mk("b", null, "9@lid")], reps: [{ id: "r1", display_name: "Marina" }],
  nudged: {}, busy: {}, nudgingAll: false, notice: null, now, onNudge: () => {}, onNudgeAll: () => {}, ...over,
});
const html = (p: SlaAlertsSectionProps) => renderToStaticMarkup(<SlaAlertsSection {...p} />);

describe("SlaAlertsSection", () => {
  it("mostra cliente, vendedor, venceu há X, link e os botões", () => {
    const out = html(base());
    expect(out).toContain("Ana Souza");
    expect(out).toContain("Contato sem telefone");
    expect(out).toContain("Marina");
    expect(out).toContain("venceu há 2 h");
    expect(out).toContain('href="/opportunities?conversa=c-a"');
    expect(out).toContain("Cutucar todos");
    expect(out.match(/>Cutucar</g)).toHaveLength(2);
  });
  it("não renderiza nada sem alertas", () => expect(html(base({ alerts: [] }))).toBe(""));
  it("linha cutucada mostra o horário no lugar do botão; enviando desabilita", () => {
    const out = html(base({ nudged: { a: "Cutucado às 14:05" }, busy: { b: true } }));
    expect(out).toContain("Cutucado às 14:05");
    expect(out.match(/>Cutucar</g)).toBeNull();
    expect(out).toContain("Enviando…");
    expect(out).toMatch(/<button[^>]*disabled[^>]*>Enviando…/);
  });
  it("erro aparece em role=alert", () => {
    expect(html(base({ notice: { kind: "error", text: "Falhou" } }))).toMatch(/role="alert"[^>]*>Falhou/);
  });
});
