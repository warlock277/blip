import { Link } from "react-router-dom";
import type { SiteSummary } from "@blip/shared";
import { ShieldCheck, ArrowUpRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBadge } from "@/components/StatusBadge";
import { UptimeBar } from "@/components/UptimeBar";
import {
  responseMs,
  uptimePct,
  uptimeColor,
  siteDisplayStatus,
  expiryChip,
  relativeTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";

/** Overview grid card for a single monitored site. */
export function SiteCard({ site }: { site: SiteSummary }) {
  const ds = siteDisplayStatus(site);
  const ssl = site.ssl ? expiryChip(site.ssl.daysRemaining, site.ssl.expiringSoon) : null;

  return (
    <Card className="group transition-shadow hover:shadow-md">
      <CardContent className="space-y-4 py-5">
        <div className="flex items-start justify-between gap-3">
          <Link to={`/sites/${site.id}`} className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h3 className="truncate font-semibold leading-tight tracking-tight group-hover:text-primary">
                {site.name}
              </h3>
              <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{site.url}</p>
          </Link>
          <StatusBadge status={ds} />
        </div>

        <div className="flex items-end justify-between">
          <div>
            <p className="text-xs text-muted-foreground">Response</p>
            <p className="text-lg font-semibold tabular-nums">
              {responseMs(site.responseTime)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">90-day uptime</p>
            <p className={cn("text-lg font-semibold tabular-nums", uptimeColor(site.uptime90d))}>
              {uptimePct(site.uptime90d)}
            </p>
          </div>
        </div>

        <UptimeBar spark={site.spark} days={45} className="h-6" />

        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Checked {relativeTime(site.lastChecked)}</span>
          {ssl && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium",
                ssl.tone,
              )}
              title={`SSL certificate: ${ssl.label === "Expired" ? "expired" : ssl.label + " remaining"}`}
            >
              <ShieldCheck className="size-3" />
              SSL {ssl.label}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
