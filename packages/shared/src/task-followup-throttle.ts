export interface FollowupThrottleInput {
  lastSentAt: string | null; // last follow-up send for this instance (any task)
  sentTodayCount: number; // sends for this instance since the start of today
  minIntervalSeconds: number;
  dailyLimit: number;
  now: Date;
}

export type FollowupThrottleResult =
  | { allowed: true }
  | { allowed: false; reason: "min_interval"; retryAfterSeconds: number }
  | { allowed: false; reason: "daily_limit" };

// Anti-ban guard for follow-up sends: scoped per WhatsApp instance (see
// task-followup.service.ts), not per organization, since an org's
// instances/numbers each carry their own ban risk independently.
export function evaluateFollowupThrottle(input: FollowupThrottleInput): FollowupThrottleResult {
  if (input.lastSentAt) {
    const elapsedSeconds = (input.now.getTime() - new Date(input.lastSentAt).getTime()) / 1000;
    if (elapsedSeconds < input.minIntervalSeconds) {
      return {
        allowed: false,
        reason: "min_interval",
        retryAfterSeconds: Math.ceil(input.minIntervalSeconds - elapsedSeconds),
      };
    }
  }

  if (input.sentTodayCount >= input.dailyLimit) {
    return { allowed: false, reason: "daily_limit" };
  }

  return { allowed: true };
}
