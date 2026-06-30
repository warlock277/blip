import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpDown, ChevronDown, ChevronUp } from "lucide-react";
import type { SiteSummary } from "@blip/shared";
import { useSummary } from "@/lib/data";
import { useAuth, scopedSites } from "@/lib/auth";
import { useBrand } from "@/components/BrandProvider";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { TableSkeleton, EmptyState, ErrorState } from "@/components/States";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card } from "@/components/ui/card";
import {
  responseMs,
  uptimePct,
  uptimeColor,
  siteDisplayStatus,
  expiryChip,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import { useLayoutSearch } from "@/components/AppLayout";

type SortKey =
  | "name"
  | "group"
  | "status"
  | "responseTime"
  | "ssl"
  | "domain"
  | "uptime24h"
  | "uptime7d"
  | "uptime30d";

type SortDir = "asc" | "desc";

const STATUS_ORDER: Record<string, number> = { down: 0, degraded: 1, up: 2, paused: 3 };

function sortValue(site: SiteSummary, key: SortKey): number | string {
  switch (key) {
    case "name":
      return site.name.toLowerCase();
    case "group":
      return site.group ?? "~";
    case "status":
      return STATUS_ORDER[siteDisplayStatus(site)] ?? 9;
    case "responseTime":
      return site.responseTime ?? Number.POSITIVE_INFINITY;
    case "ssl":
      return site.ssl?.daysRemaining ?? Number.POSITIVE_INFINITY;
    case "domain":
      return site.domain?.daysRemaining ?? Number.POSITIVE_INFINITY;
    case "uptime24h":
      return site.uptime24h;
    case "uptime7d":
      return site.uptime7d;
    case "uptime30d":
      return site.uptime30d;
  }
}

function SortHeader({
  label,
  sortKey,
  active,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          "inline-flex items-center gap-1 hover:text-foreground",
          isActive && "text-foreground",
        )}
      >
        {label}
        {isActive ? (
          dir === "asc" ? (
            <ChevronUp className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

function ExpiryCell({ days, soon }: { days: number | undefined; soon: boolean | undefined }) {
  if (days == null) return <span className="text-muted-foreground">—</span>;
  const chip = expiryChip(days, soon ?? false);
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", chip.tone)}>
      {chip.label}
    </span>
  );
}

export default function Sites() {
  const { data, error, loading, reload } = useSummary();
  const auth = useAuth();
  const search = useLayoutSearch();
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  useBrand(data?.brand);

  const onSort = (k: SortKey) => {
    if (k === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(k);
      setSortDir("asc");
    }
  };

  const rows = useMemo(() => {
    if (!data) return [];
    const visible = scopedSites(auth.scope, data.sites);
    const q = search.trim().toLowerCase();
    const filtered = q
      ? visible.filter(
          (s) =>
            s.name.toLowerCase().includes(q) ||
            s.url.toLowerCase().includes(q) ||
            (s.group ?? "").toLowerCase().includes(q),
        )
      : visible;
    const sorted = [...filtered].sort((a, b) => {
      const av = sortValue(a, sortKey);
      const bv = sortValue(b, sortKey);
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }, [data, auth, search, sortKey, sortDir]);

  const groupName = (id: string | undefined) =>
    data?.groups.find((g) => g.id === id)?.name ?? id ?? "—";

  return (
    <div>
      <PageHeader
        title="Sites"
        description="Every monitored target with response time, certificate and uptime windows."
      />

      {loading ? (
        <TableSkeleton />
      ) : error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : rows.length === 0 ? (
        <EmptyState
          title={search ? "No sites match your search" : "No sites configured"}
          hint={search ? "Try a different query." : "Add sites in blip.config.yaml."}
        />
      ) : (
        <Card className="overflow-hidden p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHeader label="Site" sortKey="name" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader label="Group" sortKey="group" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader label="Status" sortKey="status" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader
                  label="Response"
                  sortKey="responseTime"
                  active={sortKey}
                  dir={sortDir}
                  onSort={onSort}
                  className="text-right [&>button]:justify-end [&>button]:w-full"
                />
                <SortHeader label="SSL" sortKey="ssl" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader label="Domain" sortKey="domain" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader label="24h" sortKey="uptime24h" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader label="7d" sortKey="uptime7d" active={sortKey} dir={sortDir} onSort={onSort} />
                <SortHeader label="30d" sortKey="uptime30d" active={sortKey} dir={sortDir} onSort={onSort} />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((site) => (
                <TableRow key={site.id}>
                  <TableCell>
                    <Link to={`/sites/${site.id}`} className="group block min-w-0">
                      <span className="font-medium group-hover:text-primary">{site.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {site.url}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {groupName(site.group)}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={siteDisplayStatus(site)} />
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {responseMs(site.responseTime)}
                  </TableCell>
                  <TableCell>
                    <ExpiryCell days={site.ssl?.daysRemaining} soon={site.ssl?.expiringSoon} />
                  </TableCell>
                  <TableCell>
                    <ExpiryCell days={site.domain?.daysRemaining} soon={site.domain?.expiringSoon} />
                  </TableCell>
                  <TableCell className={cn("tabular-nums", uptimeColor(site.uptime24h))}>
                    {uptimePct(site.uptime24h)}
                  </TableCell>
                  <TableCell className={cn("tabular-nums", uptimeColor(site.uptime7d))}>
                    {uptimePct(site.uptime7d)}
                  </TableCell>
                  <TableCell className={cn("tabular-nums", uptimeColor(site.uptime30d))}>
                    {uptimePct(site.uptime30d)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
