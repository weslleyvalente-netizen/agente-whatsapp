import { describe, expect, it } from "vitest";
import { decideSweepAction, type SweepFacts } from "./unanswered-sweep.js";

const now = new Date("2026-10-26T15:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);
const facts = (o: Partial<SweepFacts> = {}): SweepFacts => ({
  now, createdAt: ago(30), content: "Quero um consórcio", mediaType: null, hasOutboundAfter: false,
  ignored: false, aiDisabled: false, frozen: false, isHumanTakeover: false, openHandoff: false,
  retriedAt: null, alerted: false, businessOpen: true, ...o,
});

describe("decideSweepAction", () => {
  it("retenta quando passou de 10 min e nunca foi retentado", () => {
    expect(decideSweepAction(facts({ createdAt: ago(11) }))).toEqual({ action: "retry" });
  });
  it("espera quando a mensagem tem menos de 10 min", () => {
    expect(decideSweepAction(facts({ createdAt: ago(9) }))).toEqual({ action: "skip", reason: "too_recent" });
  });
  it("fora de escopo acima de 6 h", () => {
    expect(decideSweepAction(facts({ createdAt: ago(361) }))).toEqual({ action: "skip", reason: "too_old" });
  });
  it.each([
    ["answered", { hasOutboundAfter: true }],
    ["ignored", { ignored: true }],
    ["ai_disabled", { aiDisabled: true }],
    ["frozen", { frozen: true }],
    ["no_content", { content: "  ", mediaType: null }],
  ] as const)("pula: %s", (reason, o) => {
    expect(decideSweepAction(facts(o as any))).toEqual({ action: "skip", reason });
  });
  it("mídia sem texto não é pulada", () => {
    expect(decideSweepAction(facts({ content: "", mediaType: "audio" }))).toEqual({ action: "retry" });
  });
  it("depois do retry, antes de 15 min, aguarda", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(14) }))).toEqual({ action: "skip", reason: "retry_pending" });
  });
  it("15 min depois do retry, dentro do expediente, avisa", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(15) }))).toEqual({ action: "alert" });
  });
  it("não avisa fora do expediente", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(20), businessOpen: false }))).toEqual({ action: "skip", reason: "outside_business_hours" });
  });
  it("não avisa duas vezes", () => {
    expect(decideSweepAction(facts({ retriedAt: ago(20), alerted: true }))).toEqual({ action: "skip", reason: "already_alerted" });
  });
  it("atendimento humano: nunca retenta; só avisa após 25 min", () => {
    expect(decideSweepAction(facts({ isHumanTakeover: true, createdAt: ago(20) }))).toEqual({ action: "skip", reason: "human_pending" });
    expect(decideSweepAction(facts({ isHumanTakeover: true, createdAt: ago(25) }))).toEqual({ action: "alert" });
    expect(decideSweepAction(facts({ openHandoff: true, createdAt: ago(40), businessOpen: false }))).toEqual({ action: "skip", reason: "outside_business_hours" });
    expect(decideSweepAction(facts({ openHandoff: true, createdAt: ago(40), alerted: true }))).toEqual({ action: "skip", reason: "already_alerted" });
  });
});
