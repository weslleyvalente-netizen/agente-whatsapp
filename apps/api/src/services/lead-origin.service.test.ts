import { describe, expect, it, vi } from "vitest";
import { recordLeadOrigin } from "./lead-origin.service.js";
function fixture(metadata: Record<string, unknown>) {
 const eq = vi.fn(); const update = vi.fn();
 const chain: any = { select: () => chain, eq: (...args: unknown[]) => { eq(...args); return chain; }, single: async () => ({ data: { metadata }, error: null }), update: (value: unknown) => { update(value); return chain; }, then: (resolve: any) => Promise.resolve({ error: null }).then(resolve) };
 return { db: { from: () => chain } as any, eq, update };
}
describe("record lead origin", () => {
 it("preserves unrelated metadata and scopes compare-and-set by organization", async () => {
  const f = fixture({ tag: "cliente" }); await recordLeadOrigin(f.db, "org", "contact", { source: "site_wix", evidence: "Wix" });
  expect(f.update).toHaveBeenCalledWith({ metadata: { tag: "cliente", lead_origin: expect.objectContaining({ source: "site_wix", method: "automatic" }) } });
  expect(f.eq).toHaveBeenCalledWith("organization_id", "org"); expect(f.eq).toHaveBeenCalledWith("metadata", JSON.stringify({ tag: "cliente" }));
 });
 it("does not overwrite an existing or manually corrected origin", async () => {
  const f = fixture({ lead_origin: { source: "instagram_organic", method: "manual" } }); await recordLeadOrigin(f.db, "org", "contact", { source: "site_wix", evidence: "Wix" }); expect(f.update).not.toHaveBeenCalled();
 });
 it("does not read or write when no evidence exists", async () => {
  const from = vi.fn(); await recordLeadOrigin({ from } as any, "org", "contact", null); expect(from).not.toHaveBeenCalled();
 });
});
