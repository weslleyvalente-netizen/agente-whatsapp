import { describe, it, expect } from "vitest";
import { followupAutomaticoConfigSchema, toolsConfigSchema } from "./agent.js";

describe("followupAutomaticoConfigSchema", () => {
  it("defaults to disabled with 1h/23h windows", () => {
    const result = followupAutomaticoConfigSchema.parse({});
    expect(result).toEqual({ ativo: false, primeiro_followup_horas: 1, segundo_followup_horas: 23 });
  });

  it("accepts a custom enabled config", () => {
    const result = followupAutomaticoConfigSchema.parse({
      ativo: true,
      primeiro_followup_horas: 2,
      segundo_followup_horas: 30,
    });
    expect(result).toEqual({ ativo: true, primeiro_followup_horas: 2, segundo_followup_horas: 30 });
  });

  it("rejects a non-positive hours value", () => {
    expect(() => followupAutomaticoConfigSchema.parse({ primeiro_followup_horas: 0 })).toThrow();
  });

  it("rejects an hours value over the 168h (7 day) cap", () => {
    expect(() => followupAutomaticoConfigSchema.parse({ segundo_followup_horas: 200 })).toThrow();
  });
});

describe("toolsConfigSchema", () => {
  it("fills in followup_automatico when the key is absent (legacy rows)", () => {
    const result = toolsConfigSchema.parse({
      search_knowledge: true,
      search_faq: true,
      send_catalog_photo: false,
      create_task: false,
    });
    expect(result.followup_automatico).toEqual({
      ativo: false,
      primeiro_followup_horas: 1,
      segundo_followup_horas: 23,
    });
  });
});
