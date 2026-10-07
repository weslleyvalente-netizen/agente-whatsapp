/**
 * Runs `fn` at most once per `waitMs`: the first call runs right away, calls
 * during the cooldown collapse into a single trailing run. `cancel` drops the
 * pending run (use on unmount).
 */
export function trailingThrottle(fn: () => void, waitMs: number): (() => void) & {cancel: () => void} {
 let last = -Infinity, timer: ReturnType<typeof setTimeout> | null = null;
 const run = () => { timer = null; last = Date.now(); fn(); };
 const throttled = () => {
  const remaining = last + waitMs - Date.now();
  if (remaining <= 0) { if (timer) clearTimeout(timer); run(); }
  else if (!timer) timer = setTimeout(run, remaining);
 };
 throttled.cancel = () => { if (timer) clearTimeout(timer); timer = null; };
 return throttled;
}
