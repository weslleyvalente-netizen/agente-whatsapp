// A conversation's human takeover is "expired" — the AI agent should
// auto-resume — once this much time has passed since the last human
// activity. An org can configure its own timeout, or disable auto-resume
// entirely (null); orgs that haven't configured anything fall back to
// defaultTimeoutMs.
export function isHumanTakeoverExpired(
  humanTakeoverAt: string | null,
  configuredTimeoutMinutes: number | null | undefined,
  defaultTimeoutMs: number,
  nowMs: number
): boolean {
  if (!humanTakeoverAt) return false;
  if (configuredTimeoutMinutes === null) return false;

  const timeoutMs =
    configuredTimeoutMinutes != null ? configuredTimeoutMinutes * 60 * 1000 : defaultTimeoutMs;

  return new Date(humanTakeoverAt).getTime() < nowMs - timeoutMs;
}
