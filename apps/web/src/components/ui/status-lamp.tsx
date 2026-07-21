import { cn } from "@/lib/utils";

export type LampTone = "green" | "amber" | "rust" | "off";

const TONE_STYLES: Record<LampTone, { dot: string; glow: string }> = {
  green: { dot: "bg-lamp-green", glow: "shadow-[0_0_6px_1px_var(--lamp-green)]" },
  amber: { dot: "bg-lamp-amber", glow: "shadow-[0_0_6px_1px_var(--lamp-amber)]" },
  rust: { dot: "bg-lamp-rust", glow: "shadow-[0_0_6px_1px_var(--lamp-rust)]" },
  off: { dot: "bg-muted-foreground/30", glow: "" },
};

interface StatusLampProps {
  tone: LampTone;
  pulse?: boolean;
  className?: string;
  label?: string;
}

/**
 * The app's signature indicator: a real status light, not decoration.
 * Every place this is used maps to a genuine on/off/error state
 * (instance connection, agent active state, conversation awaiting reply).
 */
export function StatusLamp({ tone, pulse, className, label }: StatusLampProps) {
  const styles = TONE_STYLES[tone];
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <span className="relative inline-flex h-2 w-2 shrink-0">
        {pulse && tone !== "off" && (
          <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60", styles.dot)} />
        )}
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", styles.dot, styles.glow)} />
      </span>
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
    </span>
  );
}
