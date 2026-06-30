import type { Incident } from "@pulse/shared";
import { Link } from "react-router-dom";
import { CircleDot, CheckCircle2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  dateTime,
  relativeTime,
  durationLabel,
  INCIDENT_TYPE_LABEL,
  INCIDENT_TYPE_TONE,
} from "@/lib/format";

interface IncidentRowProps {
  incident: Incident;
  /** Hide the site link (already on a site detail page). */
  hideSite?: boolean;
}

/** A single incident card — open incidents are visually highlighted. */
export function IncidentRow({ incident, hideSite = false }: IncidentRowProps) {
  const open = incident.state === "open";
  const tone = INCIDENT_TYPE_TONE[incident.type] ?? "bg-muted text-muted-foreground";
  const label = INCIDENT_TYPE_LABEL[incident.type] ?? incident.type;

  return (
    <Card className={cn(open && "border-down/40 bg-down-soft/30")}>
      <CardContent className="flex items-start gap-3 py-4">
        <span className={cn("mt-0.5 shrink-0", open ? "text-down" : "text-up")}>
          {open ? <CircleDot className="size-4" /> : <CheckCircle2 className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn("rounded-full px-2 py-0.5 text-xs font-medium", tone)}
            >
              {label}
            </span>
            {open ? (
              <span className="rounded-full bg-down px-2 py-0.5 text-xs font-medium text-white">
                Ongoing
              </span>
            ) : (
              <span className="rounded-full bg-up-soft px-2 py-0.5 text-xs font-medium text-up">
                Resolved
              </span>
            )}
            {!hideSite && (
              <Link
                to={`/sites/${incident.siteId}`}
                className="text-xs font-medium text-muted-foreground hover:text-primary"
              >
                {incident.siteName}
              </Link>
            )}
          </div>

          <p className="mt-1.5 font-medium leading-snug">{incident.title}</p>
          {incident.detail && (
            <p className="mt-0.5 text-sm text-muted-foreground">{incident.detail}</p>
          )}

          {incident.updates && incident.updates.length > 0 && (
            <ul className="mt-3 space-y-2 border-l border-border pl-3">
              {incident.updates.map((u, i) => (
                <li key={i} className="text-sm">
                  <span className="text-muted-foreground">{relativeTime(u.at)}</span>
                  <span className="mx-1.5 text-muted-foreground">·</span>
                  {u.message}
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Started {dateTime(incident.startedAt)}</span>
            {incident.resolvedAt && <span>Resolved {dateTime(incident.resolvedAt)}</span>}
            <span className="font-medium text-foreground">
              {open
                ? `Ongoing for ${durationLabel(Date.now() - new Date(incident.startedAt).getTime())}`
                : `Lasted ${durationLabel(incident.durationMs)}`}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
