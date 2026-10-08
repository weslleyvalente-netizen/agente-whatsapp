import { describe, expect, it } from "vitest";
import { isHumanOriginMessage, pickRep } from "./lead-distribution.js";

const marina = { id: "marina", availability: "available" as const, rotation_order: 1 };
const marcio = { id: "marcio", availability: "available" as const, rotation_order: 2 };

describe("pickRep", () => {
  it("alterna Marina → Márcio → Marina", () => {
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 0 })).toBe("marina");
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 1 })).toBe("marcio");
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 2 })).toBe("marina");
  });
  it("pula quem está pausado ou fora, sem perder a ordem", () => {
    const paused = { ...marcio, availability: "paused" as const };
    expect(pickRep({ reps: [marina, paused], lastRotationOrder: 1 })).toBe("marina");
    const out = { ...marina, availability: "out" as const };
    expect(pickRep({ reps: [out, marcio], lastRotationOrder: 0 })).toBe("marcio");
  });
  it("não devolve ninguém quando não há vendedor disponível", () => {
    expect(pickRep({ reps: [{ ...marina, availability: "paused" }, { ...marcio, availability: "out" }], lastRotationOrder: 0 })).toBeNull();
    expect(pickRep({ reps: [], lastRotationOrder: 0 })).toBeNull();
  });
  it("respeita a lista de excluídos (já recebeu este handoff)", () => {
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 0, excludeRepIds: ["marina"] })).toBe("marcio");
    expect(pickRep({ reps: [marina, marcio], lastRotationOrder: 0, excludeRepIds: ["marina", "marcio"] })).toBeNull();
  });
  it("ignora peso, limite e especialidade (preparados, não ativos)", () => {
    const weighted = { ...marina, weight: 10, max_active_leads: 0, specialties: ["x"] } as any;
    expect(pickRep({ reps: [weighted, marcio], lastRotationOrder: 0, context: { operation: "financing" } })).toBe("marina");
  });
});

describe("isHumanOriginMessage (6.1.1)", () => {
  const panel = { role: "human_agent", source: "panel" as const, actorUserId: "u1", metadata: null };
  it("mensagem do painel por usuário autenticado é humana", () => {
    expect(isHumanOriginMessage(panel)).toBe(true);
  });
  it("resposta da Mariana (agent) nunca é humana", () => {
    expect(isHumanOriginMessage({ ...panel, role: "agent" })).toBe(false);
  });
  it("mensagens automáticas marcadas não são humanas", () => {
    expect(isHumanOriginMessage({ ...panel, metadata: { low_intent_followup: { stage: 1 } } })).toBe(false);
    expect(isHumanOriginMessage({ ...panel, metadata: { scheduled_ad_closure: { batch_id: "b" } } })).toBe(false);
    expect(isHumanOriginMessage({ ...panel, metadata: { system_generated: true } })).toBe(false);
  });
  it("painel sem usuário autenticado não é humano", () => {
    expect(isHumanOriginMessage({ ...panel, actorUserId: null })).toBe(false);
  });
  it("eco do celular legítimo é humano; eco de mensagem do próprio sistema não", () => {
    const echo = { role: "human_agent", source: "phone_echo" as const, metadata: null };
    expect(isHumanOriginMessage(echo)).toBe(true);
    expect(isHumanOriginMessage({ ...echo, echoMatchedSystemMessage: true })).toBe(false);
  });
  it("saudação curta filtrada pelo celular não assume o lead", () => {
    expect(isHumanOriginMessage({ role: "human_agent", source: "phone_echo", metadata: null, greetingFiltered: true })).toBe(false);
  });
  it("mídia automática marcada não é humana", () => {
    expect(isHumanOriginMessage({ ...panel, metadata: { system_generated: true, tag: "registered_image" } })).toBe(false);
  });
});
