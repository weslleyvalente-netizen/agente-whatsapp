import { describe, expect, it } from "vitest";
import { identifyLeadOrigin } from "./lead-origin.js";
describe("lead origin evidence", () => {
  it("records Wix form", () => expect(identifyLeadOrigin({ wix: true })?.source).toBe("site_wix"));
  it("recognizes organic Instagram", () => expect(identifyLeadOrigin({ text: "Olá, vim do Instagram!" })?.source).toBe("instagram_organic"));
  it("does not guess from a question", () => expect(identifyLeadOrigin({ text: "Vocês têm Instagram?" })).toBeNull());
  it("prioritizes ad evidence", () => expect(identifyLeadOrigin({ text: "vim do Instagram", ad: { sourceUrl: "https://www.instagram.com/p/123" } })?.source).toBe("instagram_ads"));
  it("identifies Facebook ads", () => expect(identifyLeadOrigin({ ad: { sourceUrl: "https://www.facebook.com/ads/123" } })?.source).toBe("facebook_ads"));
  it("keeps unknown Meta ads unspecific", () => expect(identifyLeadOrigin({ ad: { title: "Factor" } })?.source).toBe("meta_ads"));
  it("rejects deceptive domains", () => expect(identifyLeadOrigin({ ad: { sourceUrl: "https://facebook.com.evil.test/ad" } })?.source).toBe("meta_ads"));
});
