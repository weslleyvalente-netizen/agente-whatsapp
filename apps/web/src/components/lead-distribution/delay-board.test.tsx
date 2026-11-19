import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SlaAlert } from "@aula-agente/shared";
import { DelayBoard, type DelayBoardProps } from "./delay-board";

const now = new Date("2026-11-19T15:00:00Z");
const ex = { id: "e1", rep_id: null, conversation_id: "c-david", assigned_at: "2026-11-19T12:00:00Z", exception_reason: "all_reps_sla_breached", contact_name: "David", contact_phone: "556296934565" } as unknown as SlaAlert;
const al = { id: "a1", rep_id: "r1", conversation_id: "c-clau", sla_due_at: "2026-11-19T13:00:00Z", assigned_at: "2026-11-19T12:24:00Z", contact_name: "Claudivan", contact_phone: "556296148561" } as unknown as SlaAlert;
const base = (over: Partial<DelayBoardProps> = {}): DelayBoardProps => ({ exceptions: [ex], alerts: [al], reps: [{ id: "r1", display_name: "Márcio" }], nudged: {}, busy: {}, nudgingAll: false, notice: null, now, onNudge: () => {}, onNudgeAll: () => {}, ...over });
const html = (p: DelayBoardProps) => renderToStaticMarkup(<DelayBoard {...p} />);
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("DelayBoard (Atraso no atendimento)", () => {
  it("lista quem ninguém respondeu e os atrasos da carteira, sem seletor nem botão de atribuir", () => {
    const out = html(base());
    const t = text(out);
    expect(t).toContain("Atraso no atendimento 2");
    expect(t).toContain("Ninguém respondeu 1");
    expect(t).toContain("David · Nenhum vendedor respondeu no prazo · aguardando há 3 h");
    expect(t).toContain("Claudivan · Márcio · venceu há 2 h");
    expect(out).toContain('href="/opportunities?conversa=c-david"');
    expect(out).not.toContain("<select");
    expect(out).not.toContain(">Atribuir<");
    expect(out).toContain("Cutucar todos");
  });
  it("some quando não há nada em atraso", () => expect(html(base({ exceptions: [], alerts: [] }))).toBe(""));
  it("só atrasos da carteira: sem o bloco 'Ninguém respondeu'", () => expect(text(html(base({ exceptions: [] })))).not.toContain("Ninguém respondeu"));
});
