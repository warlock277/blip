import { cn } from "@/lib/utils";
import { StatusDot } from "@/components/StatusDot";
import { STATUS_LABEL, STATUS_SOFT, type DisplayStatus } from "@/lib/format";

interface StatusBadgeProps {
  status: DisplayStatus;
  className?: string;
}

/** Pill badge with a status dot + label. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        STATUS_SOFT[status],
        className,
      )}
    >
      <StatusDot status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}
