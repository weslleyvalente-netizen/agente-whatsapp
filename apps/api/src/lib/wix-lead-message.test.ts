import { describe, it, expect } from "vitest";
import { buildWixLeadTriggerInstruction, buildWixLeadTriggerMessage } from "./wix-lead-message.js";

const fullLead = {
  name: "Jenerson Moreira Dos Santos",
  phone: "5562998561435",
  email: "aluiz784739@gmail.com",
  interest: "Consórcio de Moto",
  budget: "Mais de R$ 1.500",
  priorExperience: "Não, vai ser a primeira vez",
};

describe("buildWixLeadTriggerInstruction", () => {
  it("includes every field the form collected", () => {
    const instruction = buildWixLeadTriggerInstruction(fullLead);
    expect(instruction).toContain(fullLead.name);
    expect(instruction).toContain(fullLead.interest);
    expect(instruction).toContain(fullLead.budget);
    expect(instruction).toContain(fullLead.priorExperience);
    expect(instruction).toContain(fullLead.email);
  });

  it("omits lines for fields the form didn't collect", () => {
    const instruction = buildWixLeadTriggerInstruction({ name: "Jenerson", phone: "5562998561435" });
    expect(instruction).toContain("Jenerson");
    expect(instruction).not.toContain("Interesse:");
    expect(instruction).not.toContain("Orçamento");
    expect(instruction).not.toContain("E-mail:");
  });

  it("tells the agent not to re-ask what the lead already answered", () => {
    const instruction = buildWixLeadTriggerInstruction(fullLead);
    expect(instruction.toLowerCase()).toContain("nunca pergunte de novo");
  });
});

describe("buildWixLeadTriggerMessage", () => {
  it("is shaped as a system-role Message ready for runAgent's currentMessage", () => {
    const message = buildWixLeadTriggerMessage({
      conversationId: "conv-1",
      organizationId: "org-1",
      lead: fullLead,
    });
    expect(message.role).toBe("system");
    expect(message.conversation_id).toBe("conv-1");
    expect(message.organization_id).toBe("org-1");
    expect(message.content).toContain(fullLead.name);
  });
});
