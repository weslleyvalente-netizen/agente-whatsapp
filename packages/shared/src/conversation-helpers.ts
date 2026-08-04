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

// A conversation is "unread" for a given attendant when its last activity
// is newer than that attendant's last visit — or they've never visited it
// at all (lastReadAt undefined). Pure timestamp comparison: the caller is
// responsible for keeping lastMessageAt accurate (see the last_message_at
// fix in the webhook) and for looking up the right attendant's lastReadAt.
export function isUnread(lastMessageAt: string, lastReadAt: string | undefined): boolean {
  if (!lastReadAt) return true;
  return new Date(lastMessageAt).getTime() > new Date(lastReadAt).getTime();
}
