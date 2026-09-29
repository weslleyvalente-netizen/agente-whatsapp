export interface FollowupTouchState {
  // Timestamp of the most recent outbound message (role agent or
  // human_agent) since the customer's last reply — null if the customer
  // already replied, or there was never a touch. See task-followup.service.ts.
  lastTouchAt: string | null;
  lastTouchBy: "agent" | "human_agent" | null;
  // Count of outbound "touches" since the customer's last reply: automatic
  // nudges (auto_followup_stage_1/2) and Task follow-up sends (followup_sent).
  touchCount: number;
}

export interface FollowupCoordinationConfig {
  minHoursSinceLastTouch: number;
  maxTouchesWithoutReply: number;
}

export type FollowupCoordinationDecision =
  | { allowed: true }
  | { allowed: false; reason: "touch_limit_reached"; touchCount: number }
  | { allowed: false; reason: "recent_touch"; hoursSinceTouch: number };

// Coordination rule (point 4 of the follow-up-from-task plan): a single
// cadence per customer — any outbound touch (automatic nudge from Helena OR
// a follow-up sent from a Task) counts, respects a minimum interval, and is
// capped at a maximum count before the task should suggest marking the
// opportunity lost instead of nudging again. A customer reply resets both
// (the caller passes touchCount: 0, lastTouchAt: null once that happens).
export function evaluateFollowupCoordination(
  state: FollowupTouchState,
  config: FollowupCoordinationConfig,
  now: Date
): FollowupCoordinationDecision {
  if (state.touchCount >= config.maxTouchesWithoutReply) {
    return { allowed: false, reason: "touch_limit_reached", touchCount: state.touchCount };
  }

  if (state.lastTouchAt) {
    const hoursSinceTouch = (now.getTime() - new Date(state.lastTouchAt).getTime()) / 3_600_000;
    if (hoursSinceTouch < config.minHoursSinceLastTouch) {
      return { allowed: false, reason: "recent_touch", hoursSinceTouch };
    }
  }

  return { allowed: true };
}
