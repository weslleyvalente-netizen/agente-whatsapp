import { describe, it, expect } from "vitest";
import { unwrapWixLeadBody } from "./wix-lead.js";

describe("unwrapWixLeadBody", () => {
  // Real production case: a real lead (Geovane) submitted the site's form
  // and the webhook rejected it with 400 "Invalid payload" — the Wix
  // Automation's HTTP action nests the whole custom body under a "data"
  // key (a legacy setting not exposed in the current Automations editor),
  // so `name`/`phone` never existed at the top level the schema expected.
  it("unwraps a body nested under data", () => {
    const wixBody = {
      data: {
        name: "Geovane",
        phone: "+5561999353196",
        email: "geovanesj2017@gmail.com",
        interest: "Consórcio de Moto",
        budget: "R$ 400 — R$ 600",
        priorExperience: "Não, vai ser a primeira vez",
      },
    };

    expect(unwrapWixLeadBody(wixBody)).toEqual(wixBody.data);
  });

  it("passes through a flat body unchanged", () => {
    const flatBody = { name: "Geovane", phone: "+5561999353196" };
    expect(unwrapWixLeadBody(flatBody)).toEqual(flatBody);
  });

  it("passes through non-object bodies unchanged", () => {
    expect(unwrapWixLeadBody(null)).toBe(null);
    expect(unwrapWixLeadBody(undefined)).toBe(undefined);
  });

  it("does not unwrap when data is not an object (e.g. a real 'data' form field)", () => {
    const body = { name: "Geovane", data: "not-nested" };
    expect(unwrapWixLeadBody(body)).toEqual(body);
  });
});
