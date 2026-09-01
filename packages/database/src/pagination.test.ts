import { describe, it, expect, vi } from "vitest";
import { fetchAllPages } from "./pagination.js";

describe("fetchAllPages", () => {
  it("returns everything from a single page smaller than the page size, with one call", async () => {
    const fetchPage = vi.fn().mockResolvedValue([1, 2, 3]);
    const result = await fetchAllPages(fetchPage, 1000);
    expect(result).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("keeps fetching subsequent pages until a partial page signals the end", async () => {
    // Real production case: getAgentMessagesForCost had no pagination at
    // all, so once an org passed 1000 agent messages, PostgREST's default
    // row cap silently dropped everything after row 1000 — and since the
    // query ordered ascending, that meant the MOST RECENT messages went
    // missing from the cost dashboard, not the oldest.
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce([0, 1, 2])
      .mockResolvedValueOnce([3, 4, 5])
      .mockResolvedValueOnce([6]);

    const result = await fetchAllPages(fetchPage, 3);

    expect(result).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 2);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 3, 5);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 6, 8);
  });

  it("stops after one call when the first page is already empty", async () => {
    const fetchPage = vi.fn().mockResolvedValue([]);
    const result = await fetchAllPages(fetchPage, 1000);
    expect(result).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
