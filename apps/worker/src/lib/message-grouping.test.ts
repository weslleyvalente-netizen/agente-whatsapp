import { describe, it, expect } from "vitest";
import { collectPendingContactMessages, isReplyStillFresh } from "./message-grouping.js";

const msg = (id: string, role: string, created_at: string) => ({ id, role, created_at }) as any;

describe("collectPendingContactMessages", () => {
  it("returns every contact message after the last agent message, in order", () => {
    const recent = [
      msg("1", "contact", "2026-09-23T10:00:00Z"),
      msg("2", "agent", "2026-09-23T10:00:05Z"),
      msg("3", "contact", "2026-09-23T10:01:00Z"),
      msg("4", "contact", "2026-09-23T10:01:03Z"),
      msg("5", "contact", "2026-09-23T10:01:06Z"),
    ];

    const result = collectPendingContactMessages(recent);

    expect(result.map((m) => m.id)).toEqual(["3", "4", "5"]);
  });

  it("treats a human_agent message the same as an agent message as the turn boundary", () => {
    const recent = [
      msg("1", "contact", "2026-09-23T10:00:00Z"),
      msg("2", "human_agent", "2026-09-23T10:00:05Z"),
      msg("3", "contact", "2026-09-23T10:01:00Z"),
    ];

    expect(collectPendingContactMessages(recent).map((m) => m.id)).toEqual(["3"]);
  });

  it("returns an empty list when the most recent message is not from the contact (nothing pending)", () => {
    const recent = [
      msg("1", "contact", "2026-09-23T10:00:00Z"),
      msg("2", "agent", "2026-09-23T10:00:05Z"),
    ];

    expect(collectPendingContactMessages(recent)).toEqual([]);
  });

  it("returns every contact message when there is no prior agent/human message in the window", () => {
    const recent = [msg("1", "contact", "2026-09-23T10:00:00Z"), msg("2", "contact", "2026-09-23T10:00:01Z")];

    expect(collectPendingContactMessages(recent).map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("returns an empty list for an empty history", () => {
    expect(collectPendingContactMessages([])).toEqual([]);
  });
});

describe("isReplyStillFresh", () => {
  it("is fresh when no contact message exists newer than the batch's last message", () => {
    expect(isReplyStillFresh("2026-09-23T10:01:06Z", "2026-09-23T10:01:06Z")).toBe(true);
  });

  it("is fresh when the latest contact message is the same one the batch already answered", () => {
    expect(isReplyStillFresh("2026-09-23T10:01:06Z", "2026-09-23T10:00:00Z")).toBe(true);
  });

  it("is stale when a newer contact message arrived while the reply was being generated", () => {
    expect(isReplyStillFresh("2026-09-23T10:01:06Z", "2026-09-23T10:01:07.500Z")).toBe(false);
  });

  it("is fresh when there is no contact message at all (defensive default)", () => {
    expect(isReplyStillFresh("2026-09-23T10:01:06Z", null)).toBe(true);
  });
});
