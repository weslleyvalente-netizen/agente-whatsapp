import { describe, expect, it } from "vitest";
import { isFinancingMockEnabled } from "./financing-mock";

describe("isFinancingMockEnabled", () => {
  it.each([[undefined], [null], [{}], [{ financing_mock_enabled: false }], [{ financing_mock_enabled: "true" as unknown as boolean }]])(
    "desativado por padrão (%j)", (settings) => expect(isFinancingMockEnabled(settings)).toBe(false),
  );
  it("só liga com true explícito", () => expect(isFinancingMockEnabled({ financing_mock_enabled: true })).toBe(true));
});
