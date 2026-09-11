import { describe, it, expect } from "vitest";
import { wixLeadWebhookSchema } from "./wix-lead.js";

describe("wixLeadWebhookSchema", () => {
  it("accepts a full payload", () => {
    const result = wixLeadWebhookSchema.safeParse({
      name: "Jenerson Moreira Dos Santos",
      phone: "+55 62 99856-1435",
      email: "aluiz784739@gmail.com",
      interest: "Consórcio de Moto",
      budget: "Mais de R$ 1.500",
      priorExperience: "Não, vai ser a primeira vez",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a payload with only the required fields", () => {
    const result = wixLeadWebhookSchema.safeParse({
      name: "Jenerson",
      phone: "+55 62 99856-1435",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a payload missing name", () => {
    const result = wixLeadWebhookSchema.safeParse({ phone: "+55 62 99856-1435" });
    expect(result.success).toBe(false);
  });

  it("rejects a payload missing phone", () => {
    const result = wixLeadWebhookSchema.safeParse({ name: "Jenerson" });
    expect(result.success).toBe(false);
  });

  it("accepts explicit null for optional fields the customer left blank on the form", () => {
    const result = wixLeadWebhookSchema.safeParse({
      name: "Douglas",
      phone: "+55 62 99963-1527",
      email: null,
      interest: "Consórcio",
      budget: null,
      priorExperience: null,
    });
    expect(result.success).toBe(true);
  });
});
