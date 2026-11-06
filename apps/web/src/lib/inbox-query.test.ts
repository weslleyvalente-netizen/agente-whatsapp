import { describe, it, expect, vi } from "vitest";
import {
  PAGE_SIZE,
  tabFilter,
  searchTerms,
  buildSearchOr,
  loadMoreRange,
  windowRange,
  appendPage,
  createGeneration,
  createThrottle,
  hasMore,
  mergeFirstPage,
  mergeAttention,
  ATTENTION_CAP,
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
  it("strips PostgREST specials and like wildcards", () => {
    const t = searchTerms("a,b(c)%d*e")!;
    expect(t.text).toBe("abcde");
  });
  it("escapes underscore so it is not a one-char LIKE wildcard", () => {
    expect(searchTerms("a_b")!.text).toBe("a\\_b");
    expect(buildSearchOr("a_b")).toBe("name.ilike.%a\\_b%");
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
  it("loadMoreRange starts exactly at the loaded count", () => {
    expect(loadMoreRange(0)).toEqual({ from: 0, to: PAGE_SIZE - 1 });
    expect(loadMoreRange(95)).toEqual({ from: 95, to: 95 + PAGE_SIZE - 1 });
  });
  it("windowRange covers everything loaded, at least one page", () => {
    expect(windowRange(0)).toEqual({ from: 0, to: PAGE_SIZE - 1, size: PAGE_SIZE });
    expect(windowRange(120)).toEqual({ from: 0, to: 119, size: 120 });
  });
  it("hasMore compares with what was requested", () => {
    expect(hasMore(PAGE_SIZE)).toBe(true);
    expect(hasMore(PAGE_SIZE - 1)).toBe(false);
    expect(hasMore(0)).toBe(false);
    expect(hasMore(120, 120)).toBe(true);
    expect(hasMore(119, 120)).toBe(false);
  });
  it("load more after rows disappeared skips nothing", () => {
    // servidor: 200 linhas em ordem; cliente carregou 100 e 5 saíram do filtro
    const server = Array.from({ length: 200 }, (_, i) => ({ id: `r${String(i).padStart(3, "0")}` }));
    const gone = new Set(["r003", "r010", "r020", "r030", "r040"]);
    const serverNow = server.filter((r) => !gone.has(r.id));
    // refresh por janela substitui a lista pelo que o servidor devolve para 0..99
    const w = windowRange(100);
    const loaded = serverNow.slice(w.from, w.to + 1);
    expect(loaded).toHaveLength(100);
    const r = loadMoreRange(loaded.length);
    const next = serverNow.slice(r.from, r.to + 1);
    const all = appendPage(loaded, next);
    expect(all.map((x) => x.id)).toEqual(serverNow.slice(0, 150).map((x) => x.id));
  });
  it("appendPage drops duplicate ids", () => {
    expect(appendPage([{ id: "a" }], [{ id: "a" }, { id: "b" }]).map((x) => x.id)).toEqual(["a", "b"]);
  });
});

describe("createGeneration", () => {
  it("discards a response computed against an older generation", () => {
    const g = createGeneration();
    const loadMore = g.begin();
    const refresh = g.begin();
    expect(g.commit(refresh)).toBe(true); // refresh aplicado, geração avança
    expect(g.commit(loadMore)).toBe(false); // load-more em voo é descartado
  });
  it("reset invalidates in-flight work", () => {
    const g = createGeneration();
    const t = g.begin();
    g.reset();
    expect(g.commit(t)).toBe(false);
    expect(g.commit(g.begin())).toBe(true);
  });
});

describe("createThrottle", () => {
  it("fires within the wait even with continuous events", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = createThrottle(fn, 2000);
    for (let i = 0; i < 10; i++) {
      t.trigger();
      vi.advanceTimersByTime(500);
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
  it("collapses a burst into one call and can be cancelled", () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const t = createThrottle(fn, 2000);
    t.trigger(); t.trigger(); t.trigger();
    vi.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
    t.trigger(); t.cancel();
    vi.advanceTimersByTime(5000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
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

describe("mergeAttention", () => {
  const c = (id: string, at: string) => ({ id, last_message_at: at });
  it("dedupes by id and sorts desc", () => {
    const out = mergeAttention([c("a", "2026-01-01"), c("b", "2026-01-03")], [c("b", "2026-01-03"), c("c", "2026-01-02")]);
    expect(out.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
  it("caps the merged list", () => {
    const many = Array.from({ length: 5 }, (_, i) => c(`x${i}`, `2026-01-0${i + 1}`));
    expect(mergeAttention(many, [], 3)).toHaveLength(3);
    expect(ATTENTION_CAP).toBe(300);
  });
});
