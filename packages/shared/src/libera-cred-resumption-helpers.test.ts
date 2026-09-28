import { describe, expect, it } from "vitest";
import {
  isLiberaCredTableOutdated,
  resolveLiberaCredCadenceStage,
} from "./libera-cred-resumption-helpers.js";

describe("isLiberaCredTableOutdated", () => {
  it("is outdated when no table was found and no document date exists", () => {
    expect(isLiberaCredTableOutdated(null, null, "2026-09-28", 30)).toBe(true);
  });

  it("uses the date extracted from the table text when present", () => {
    expect(isLiberaCredTableOutdated("2026-09-20", "2026-01-01", "2026-09-28", 30)).toBe(false);
    expect(isLiberaCredTableOutdated("2026-06-01", "2026-09-27", "2026-09-28", 30)).toBe(true);
  });

  it("falls back to the source document's updated_at when the text has no explicit date", () => {
    expect(isLiberaCredTableOutdated(null, "2026-09-20", "2026-09-28", 30)).toBe(false);
    expect(isLiberaCredTableOutdated(null, "2026-01-01", "2026-09-28", 30)).toBe(true);
  });

  it("is not outdated exactly at the age cap", () => {
    expect(isLiberaCredTableOutdated("2026-08-29", null, "2026-09-28", 30)).toBe(false);
  });
});

// Mirrors decideFollowupStage's pattern (task-helpers.ts): the caller derives
// escalateAlreadySent/suggestLostAlreadyLogged from this opportunity's own
// task_events (same idempotency principle as stage1AlreadySent there) so a
// 15-minute re-tick never re-fires a step that already happened.
describe("resolveLiberaCredCadenceStage", () => {
  it("does nothing before day 2 with no task open yet", () => {
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 1,
        hasOpenResumptionTask: false,
        escalateAlreadySent: false,
        suggestLostAlreadyLogged: false,
      })
    ).toBe("none");
  });

  it("creates a task at day 2 when none is open yet", () => {
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 2,
        hasOpenResumptionTask: false,
        escalateAlreadySent: false,
        suggestLostAlreadyLogged: false,
      })
    ).toBe("create");
  });

  it("does nothing between day 2 and day 7 once a task is already open", () => {
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 5,
        hasOpenResumptionTask: true,
        escalateAlreadySent: false,
        suggestLostAlreadyLogged: false,
      })
    ).toBe("none");
  });

  it("escalates at day 7 if a task is already open and hasn't escalated yet", () => {
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 7,
        hasOpenResumptionTask: true,
        escalateAlreadySent: false,
        suggestLostAlreadyLogged: false,
      })
    ).toBe("escalate");
  });

  it("does not re-escalate once already sent", () => {
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 7.3,
        hasOpenResumptionTask: true,
        escalateAlreadySent: true,
        suggestLostAlreadyLogged: false,
      })
    ).toBe("suggest_lost");
  });

  it("still creates (not escalates) past day 7 if no task exists yet", () => {
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 9,
        hasOpenResumptionTask: false,
        escalateAlreadySent: false,
        suggestLostAlreadyLogged: false,
      })
    ).toBe("create");
  });

  it("suggests marking as lost once escalated and past day 7, but only once", () => {
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 8,
        hasOpenResumptionTask: true,
        escalateAlreadySent: true,
        suggestLostAlreadyLogged: false,
      })
    ).toBe("suggest_lost");
    expect(
      resolveLiberaCredCadenceStage({
        daysStalled: 15,
        hasOpenResumptionTask: true,
        escalateAlreadySent: true,
        suggestLostAlreadyLogged: true,
      })
    ).toBe("none");
  });
});
