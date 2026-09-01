import { describe, it, expect } from "vitest";
import { computeLockedFields, filterUnlockedFields, decideCpfWriteAction } from "./conversation-qualification.js";

describe("computeLockedFields", () => {
  it("locks a field that is written with a non-null, non-empty value", () => {
    expect(computeLockedFields([], { down_payment_amount: 5000 })).toEqual(["down_payment_amount"]);
  });

  it("keeps existing locked fields not touched by this write", () => {
    expect(computeLockedFields(["city"], { down_payment_amount: 5000 })).toEqual(
      expect.arrayContaining(["city", "down_payment_amount"])
    );
  });

  it("unlocks a field written as null", () => {
    expect(computeLockedFields(["city", "down_payment_amount"], { city: null })).toEqual(["down_payment_amount"]);
  });

  it("unlocks a field written as an empty string", () => {
    expect(computeLockedFields(["city"], { city: "" })).toEqual([]);
  });

  it("re-locking an already-locked field is idempotent (no duplicates)", () => {
    expect(computeLockedFields(["city"], { city: "Goiânia" })).toEqual(["city"]);
  });
});

describe("filterUnlockedFields", () => {
  it("drops fields present in lockedFields", () => {
    expect(filterUnlockedFields({ city: "Goiânia", down_payment_amount: 5000 }, ["city"])).toEqual({
      down_payment_amount: 5000,
    });
  });

  it("passes through fields not in lockedFields unchanged", () => {
    expect(filterUnlockedFields({ city: "Goiânia" }, [])).toEqual({ city: "Goiânia" });
  });

  it("returns an empty object when every field is locked", () => {
    expect(filterUnlockedFields({ city: "Goiânia" }, ["city"])).toEqual({});
  });
});

describe("decideCpfWriteAction", () => {
  it("returns 'none' when no new CPF hash is provided", () => {
    expect(decideCpfWriteAction(null, null)).toBe("none");
    expect(decideCpfWriteAction("existing-hash", null)).toBe("none");
  });

  it("returns 'set' when there is no existing CPF and a new one is provided", () => {
    expect(decideCpfWriteAction(null, "new-hash")).toBe("set");
  });

  it("returns 'none' when the new hash matches the existing one (idempotent resend)", () => {
    expect(decideCpfWriteAction("same-hash", "same-hash")).toBe("none");
  });

  it("returns 'replace' when the new hash differs from the existing one", () => {
    expect(decideCpfWriteAction("old-hash", "new-hash")).toBe("replace");
  });
});
