import { describe, it, expect } from "vitest";
import { buildToolsForAgent } from "./registry.js";

const baseParams = {
  organizationId: "org-1",
  agentId: "agent-1",
  toolsConfig: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true, update_qualification: false },
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
      { model: "Factor 150" },
      { toolCallId: "call-2", messages: [], context: undefined }
    );
    expect(result).toContain("[SIMULADO]");
  });
});

describe("buildToolsForAgent prompt caching", () => {
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
      toolsConfig: { search_knowledge: true, search_faq: false, send_catalog_photo: false, create_task: false, update_qualification: false },
    });
    expect(Object.keys(tools)).toEqual(["searchKnowledge"]);
    expect(tools.searchKnowledge.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("does nothing when no tools are enabled", () => {
    const tools = buildToolsForAgent({
      ...baseParams,
      toolsConfig: { search_knowledge: false, search_faq: false, send_catalog_photo: false, create_task: false, update_qualification: false },
    });
    expect(tools).toEqual({});
  });
});
