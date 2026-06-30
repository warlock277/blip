import { useMemo } from "react";
import type { DailyRollup, Status } from "@pulse/shared";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { uptimePct } from "@/lib/format";

/** One bar in the strip: a day's worth of status, or "no data". */
interface Bucket {
  key: string;
  status: Status | "empty";
  uptime: number | null;
  label: string;
}

const STATUS_COLOR: Record<Status | "empty", string> = {
  up: "bg-up",
  degraded: "bg-degraded",
  down: "bg-down",
  empty: "bg-border",
};

function dailyToBucket(day: DailyRollup): Bucket {
  let status: Status = "up";
  if (day.total === 0) {
    return { key: day.d, status: "up", uptime: 1, label: day.d };
  }
  if (day.down > 0 && day.uptime < 0.5) status = "down";
  else if (day.down > 0 || day.degraded > 0 || day.uptime < 1) status = "degraded";
  return { key: day.d, status, uptime: day.uptime, label: day.d };
}

interface UptimeBarProps {
  /** Daily rollups (oldest → newest). The last `days` are shown. */
  daily?: DailyRollup[];
  /** Fallback recent status buckets (oldest → newest) when no rollups exist. */
  spark?: Status[];
  /** Number of bars to render (right-aligned, padded with empties). */
  days?: number;
  /** Bar height. */
  className?: string;
  /** Show the date range caption below the strip. */
  showLegend?: boolean;
}

/**
 * Statuspage / Upptime-style uptime strip: thin bars colored by daily status,
 * each with a hover tooltip showing the date + uptime %. Right-aligned to
 * "today"; missing history is padded with neutral "no data" bars.
 */
export function UptimeBar({
  daily,
  spark,
  days = 90,
  className,
  showLegend = false,
}: UptimeBarProps) {
  const buckets = useMemo<Bucket[]>(() => {
    let source: Bucket[];
    if (daily && daily.length > 0) {
      source = daily.slice(-days).map(dailyToBucket);
    } else if (spark && spark.length > 0) {
      source = spark.slice(-days).map((s, i) => ({
        key: `s${i}`,
        status: s,
        uptime: s === "up" ? 1 : s === "degraded" ? 0.5 : 0,
        label: "",
      }));
    } else {
      source = [];
    }
    // Left-pad with empties so the strip always has `days` bars.
    const pad = Math.max(0, days - source.length);
    const empties: Bucket[] = Array.from({ length: pad }, (_, i) => ({
      key: `e${i}`,
      status: "empty",
      uptime: null,
      label: "",
    }));
    return [...empties, ...source];
  }, [daily, spark, days]);

  const range = useMemo(() => {
    const labeled = buckets.filter((b) => b.label);
    const first = labeled[0]?.label;
    const last = labeled[labeled.length - 1]?.label;
    return { first, last, count: labeled.length };
  }, [buckets]);

  return (
    <div className="w-full">
      <TooltipProvider delayDuration={80}>
        <div className={cn("flex h-8 w-full items-stretch gap-[2px]", className)}>
          {buckets.map((b) => (
            <Tooltip key={b.key}>
              <TooltipTrigger asChild>
                <div
                  className={cn(
                    "h-full min-w-[2px] flex-1 rounded-[2px] transition-opacity hover:opacity-70",
                    STATUS_COLOR[b.status],
                  )}
                  aria-label={b.label ? `${b.label}: ${uptimePct(b.uptime)} uptime` : "No data"}
                />
              </TooltipTrigger>
              <TooltipContent>
                {b.status === "empty" || !b.label ? (
                  <span className="text-muted-foreground">No data</span>
                ) : (
                  <div className="space-y-0.5 text-center">
                    <div className="font-medium">{b.label}</div>
                    <div className="text-muted-foreground">{uptimePct(b.uptime)} uptime</div>
                  </div>
                )}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>
      {showLegend && range.count > 0 && (
        <div className="mt-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{range.count} days ago</span>
          <span>Today</span>
        </div>
      )}
    </div>
  );
}
