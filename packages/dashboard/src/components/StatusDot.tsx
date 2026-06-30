import { cn } from "@/lib/utils";
import { STATUS_BG, type DisplayStatus } from "@/lib/format";

interface StatusDotProps {
  status: DisplayStatus;
  /** Show an animated ping ring (for "up" / live indicators). */
  pulse?: boolean;
  className?: string;
}

/** A small colored status dot, optionally with a live pulse ring. */
export function StatusDot({ status, pulse = false, className }: StatusDotProps) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)}>
      {pulse && status === "up" && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-75 animate-pulse-ring",
            STATUS_BG[status],
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", STATUS_BG[status])} />
    </span>
  );
}
