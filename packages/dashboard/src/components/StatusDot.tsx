import { cn } from "@/lib/utils";
import { STATUS_BG, type DisplayStatus } from "@/lib/format";

interface StatusDotProps {
  status: DisplayStatus;
  /** Show an animated ping ring (for "up" / live indicators). */
  blip?: boolean;
  className?: string;
}

/** A small colored status dot, optionally with a live blip ring. */
export function StatusDot({ status, blip = false, className }: StatusDotProps) {
  return (
    <span className={cn("relative inline-flex size-2.5 shrink-0", className)}>
      {blip && status === "up" && (
        <span
          className={cn(
            "absolute inline-flex h-full w-full rounded-full opacity-75 animate-blip-ring",
            STATUS_BG[status],
          )}
        />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", STATUS_BG[status])} />
    </span>
  );
}
