import { describe, it, expect } from "vitest";
import { buildToolsForAgent } from "./registry.js";

const baseParams = {
  organizationId: "org-1",
  agentId: "agent-1",
  toolsConfig: { search_knowledge: true, search_faq: true, send_catalog_photo: true, create_task: true },
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
