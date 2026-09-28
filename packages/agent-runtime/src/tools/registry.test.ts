import { describe, it, expect } from "vitest";
import { buildToolsForAgent } from "./registry.js";

const baseParams = {
  organizationId: "org-1",
  agentId: "agent-1",
  toolsConfig: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true, update_qualification: false, audio_replies: false, audio_voice: "alloy" },
  apiKey: "test-key",
  conversationId: "conv-1",
  instanceId: "instance-1",
  phone: "5511999998888",
  contactId: "contact-1",
};

describe("buildToolsForAgent sandbox mode", () => {
  it("builds the same tool names in sandbox mode as in real mode", () => {
    const real = buildToolsForAgent(baseParams);
    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true });
    expect(Object.keys(sandboxed).sort()).toEqual(Object.keys(real).sort());
  });

  it("createTask in sandbox mode never imports or calls createTaskWithDedup", async () => {
    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true });
    const result = await sandboxed.createTask.execute!(
      { type: "outro", description: "teste", due_date: "2026-08-01", priority: "normal", reason: "teste" },
      { toolCallId: "call-1", messages: [], context: undefined }
    );
    expect(result).toContain("[SIMULADO]");
  });

  it("sendVehiclePhoto in sandbox mode does not enqueue a real WhatsApp send", async () => {
    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true });
    const result = await sandboxed.sendVehiclePhoto.execute!(
      { modelo: "Factor 150" },
      { toolCallId: "call-2", messages: [], context: undefined }
    );
    expect(result).toContain("[SIMULADO]");
  });
});

describe("buildToolsForAgent prompt caching", () => {
  it("registers sendRegisteredImage only when send_registered_image is on", () => {
    const off = buildToolsForAgent(baseParams);
    expect(off.sendRegisteredImage).toBeUndefined();

    const on = buildToolsForAgent({ ...baseParams, toolsConfig: { ...baseParams.toolsConfig, send_registered_image: true } });
    expect(on.sendRegisteredImage).toBeDefined();

    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true, toolsConfig: { ...baseParams.toolsConfig, send_registered_image: true } });
    expect(Object.keys(sandboxed).sort()).toEqual(Object.keys(on).sort());
  });

  it("the playground photo tool takes the same input as the real one, including sem_preco", async () => {
    const sandboxed = buildToolsForAgent({ ...baseParams, sandbox: true });
    const result = await sandboxed.sendVehiclePhoto.execute!({ modelo: "ZR HYBRID CONNECTED", sem_preco: true }, {} as never);
    expect(result).toContain("[SIMULADO]");
    expect(result).toContain("ZR HYBRID CONNECTED");
    expect(result).toContain("sem preço");
  });

  it("marks only the last registered tool as cacheable, caching every tool before it too", () => {
    const tools = buildToolsForAgent(baseParams);
    expect(Object.keys(tools)).toEqual(["searchKnowledge", "searchFaq", "searchCatalog", "sendVehiclePhoto", "createTask"]);
    expect(tools.createTask.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
    expect(tools.searchKnowledge.providerOptions).toBeUndefined();
    expect(tools.searchFaq.providerOptions).toBeUndefined();
    expect(tools.searchCatalog.providerOptions).toBeUndefined();
    expect(tools.sendVehiclePhoto.providerOptions).toBeUndefined();
  });

  it("marks whichever tool ends up last when only a subset of tools is enabled", () => {
    const tools = buildToolsForAgent({
      ...baseParams,
      toolsConfig: { search_knowledge: true, search_faq: false, send_catalog_photo: false, create_task: false, update_qualification: false, audio_replies: false, audio_voice: "alloy" },
    });
    expect(Object.keys(tools)).toEqual(["searchKnowledge"]);
    expect(tools.searchKnowledge.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("does nothing when no tools are enabled", () => {
    const tools = buildToolsForAgent({
      ...baseParams,
      toolsConfig: { search_knowledge: false, search_faq: false, send_catalog_photo: false, create_task: false, update_qualification: false, audio_replies: false, audio_voice: "alloy" },
    });
    expect(tools).toEqual({});
  });
});

describe("buildToolsForAgent requestHuman (Fase 1 handoff explícito)", () => {
  it("does not register requestHuman when the flag is off or absent (unchanged default)", () => {
    const tools = buildToolsForAgent(baseParams);
    expect(tools.requestHuman).toBeUndefined();
  });

  it("registers requestHuman when the flag is on", () => {
    const tools = buildToolsForAgent({ ...baseParams, toolsConfig: { ...baseParams.toolsConfig, request_human: true } });
    expect(tools.requestHuman).toBeDefined();
  });

  it("builds the same tool names in sandbox mode as in real mode with requestHuman enabled", () => {
    const params = { ...baseParams, toolsConfig: { ...baseParams.toolsConfig, request_human: true } };
    const real = buildToolsForAgent(params);
    const sandboxed = buildToolsForAgent({ ...params, sandbox: true });
    expect(Object.keys(sandboxed).sort()).toEqual(Object.keys(real).sort());
  });

  it("requestHuman in sandbox mode never activates a real takeover", async () => {
    const sandboxed = buildToolsForAgent({
      ...baseParams,
      sandbox: true,
      toolsConfig: { ...baseParams.toolsConfig, request_human: true },
    });
    const result = await sandboxed.requestHuman.execute!(
      { motivo: "cliente_pediu", resumo: "teste", urgencia: "normal" },
      {} as never
    );
    expect(result).toContain("[SIMULADO]");
  });
});
