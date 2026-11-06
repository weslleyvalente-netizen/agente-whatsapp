import { describe, it, expect } from "vitest";
import {
  PAGE_SIZE,
  tabFilter,
  searchTerms,
  buildSearchOr,
  pageRange,
  hasMore,
  mergeFirstPage,
} from "./inbox-query";

describe("tabFilter", () => {
  const base = { userId: "u1", distributionOn: false, role: "owner" as string | null };
  it("all has no filter", () => {
    expect(tabFilter("all", base)).toEqual({ kind: "none" });
  });
  it("mine = assigned to me", () => {
    expect(tabFilter("mine", base)).toEqual({ kind: "assigned_to_me", userId: "u1" });
  });
  it("mine for agent with distribution includes unassigned", () => {
    expect(tabFilter("mine", { ...base, role: "agent", distributionOn: true })).toEqual({
      kind: "assigned_to_me_or_unassigned",
      userId: "u1",
    });
  });
  it("mine for agent without distribution stays strict", () => {
    expect(tabFilter("mine", { ...base, role: "agent" })).toEqual({ kind: "assigned_to_me", userId: "u1" });
  });
  it("mine/others without userId match nothing", () => {
    expect(tabFilter("mine", { ...base, userId: null })).toEqual({ kind: "nothing" });
    expect(tabFilter("others", { ...base, userId: null })).toEqual({ kind: "nothing" });
  });
  it("agent, others, attention", () => {
    expect(tabFilter("agent", base)).toEqual({ kind: "ai_handling" });
    expect(tabFilter("others", base)).toEqual({ kind: "assigned_to_others", userId: "u1" });
    expect(tabFilter("attention", base)).toEqual({ kind: "attention" });
  });
});

describe("searchTerms / buildSearchOr", () => {
  it("returns null for blank", () => {
    expect(searchTerms("   ")).toBeNull();
    expect(buildSearchOr("")).toBeNull();
  });
  it("escapes PostgREST specials and like wildcards", () => {
    const t = searchTerms("a,b(c)%d_e")!;
    expect(t.text).not.toMatch(/[,()%]/);
  });
  it("normalizes masked phone to digits", () => {
    const t = searchTerms("(62) 99461-447")!;
    expect(t.digits).toBe("6299461447");
  });
  it("uses digits for phone when text looks like a masked phone", () => {
    expect(buildSearchOr("(62) 9946")).toBe("name.ilike.%62 9946%,phone.ilike.%629946%");
  });
  it("omits the phone clause when text has letters mixed with digits", () => {
    expect(buildSearchOr("Ana 2")).toBe("name.ilike.%Ana 2%");
  });
  it("omits the phone clause for pure names", () => {
    expect(buildSearchOr("Ana")).toBe("name.ilike.%Ana%");
  });
});

describe("paging", () => {
  it("pageRange", () => {
    expect(pageRange(0)).toEqual({ from: 0, to: PAGE_SIZE - 1 });
    expect(pageRange(2)).toEqual({ from: 2 * PAGE_SIZE, to: 3 * PAGE_SIZE - 1 });
  });
  it("hasMore when page came full", () => {
    expect(hasMore(PAGE_SIZE)).toBe(true);
    expect(hasMore(PAGE_SIZE - 1)).toBe(false);
    expect(hasMore(0)).toBe(false);
  });
});

describe("mergeFirstPage", () => {
  const c = (id: string, at: string, extra = {}) => ({ id, last_message_at: at, ...extra });
  it("replaces by id, keeps older, sorts desc", () => {
    const loaded = [c("a", "2026-01-03"), c("b", "2026-01-02"), c("z", "2026-01-01")];
    const fresh = [c("b", "2026-01-05", { v: 2 }), c("n", "2026-01-04")];
    expect(mergeFirstPage(loaded, fresh).map((x) => x.id)).toEqual(["b", "n", "a", "z"]);
    expect(mergeFirstPage(loaded, fresh)[0]).toMatchObject({ v: 2 });
  });
  it("tie-breaks by id desc", () => {
    const out = mergeFirstPage([c("a", "2026-01-01")], [c("b", "2026-01-01")]);
    expect(out.map((x) => x.id)).toEqual(["b", "a"]);
  });
  it("does not mutate inputs", () => {
    const loaded = [c("a", "2026-01-01")];
    mergeFirstPage(loaded, [c("b", "2026-01-02")]);
    expect(loaded).toHaveLength(1);
  });
});
