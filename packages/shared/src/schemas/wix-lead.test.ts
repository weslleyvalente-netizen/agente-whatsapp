import { describe, it, expect } from "vitest";
import { normalizeWixLead, wixLeadWebhookSchema } from "./wix-lead.js";

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

  // Wix "choice" fields (dropdowns) serialize as an array even when a
  // single option is selected — this is what real Wix submissions send,
  // not a plain string.
  it("accepts arrays for the dropdown fields (interest/budget/priorExperience)", () => {
    const result = wixLeadWebhookSchema.safeParse({
      name: "Kauã Gustavo Ribeiro Vieira",
      phone: "+55 62 99680-7555",
      email: "kg9549235@gmail.com",
      interest: ["Consórcio de Imóveis"],
      budget: ["R$ 400 — R$ 600"],
      priorExperience: ["Não, vai ser a primeira vez"],
    });
    expect(result.success).toBe(true);
  });
});

describe("normalizeWixLead", () => {
  it("flattens single-element dropdown arrays into plain strings", () => {
    const normalized = normalizeWixLead({
      name: "Kauã Gustavo Ribeiro Vieira",
      phone: "+55 62 99680-7555",
      email: "kg9549235@gmail.com",
      interest: ["Consórcio de Imóveis"],
      budget: ["R$ 400 — R$ 600"],
      priorExperience: ["Não, vai ser a primeira vez"],
    });
    expect(normalized).toEqual({
      name: "Kauã Gustavo Ribeiro Vieira",
      phone: "+55 62 99680-7555",
      email: "kg9549235@gmail.com",
      interest: "Consórcio de Imóveis",
      budget: "R$ 400 — R$ 600",
      priorExperience: "Não, vai ser a primeira vez",
    });
  });

  it("turns null fields into undefined", () => {
    const normalized = normalizeWixLead({
      name: "Douglas",
      phone: "+55 62 99963-1527",
      email: null,
      interest: "Consórcio",
      budget: null,
      priorExperience: null,
    });
    expect(normalized.email).toBeUndefined();
    expect(normalized.budget).toBeUndefined();
    expect(normalized.priorExperience).toBeUndefined();
    expect(normalized.interest).toBe("Consórcio");
  });

  it("joins multi-select dropdown arrays with a comma", () => {
    const normalized = normalizeWixLead({
      name: "Teste",
      phone: "+55 62 90000-0000",
      interest: ["Consórcio de Moto", "Consórcio de Carro"],
    });
    expect(normalized.interest).toBe("Consórcio de Moto, Consórcio de Carro");
  });
});
