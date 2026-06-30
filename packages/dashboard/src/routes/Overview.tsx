import { useMemo, useState } from "react";
import {
  Activity,
  ArrowUpCircle,
  ArrowDownCircle,
  Gauge,
  AlertTriangle,
} from "lucide-react";
import { useSummary } from "@/lib/data";
import { useAuth, scopedSites } from "@/lib/auth";
import { useBrand } from "@/components/BrandProvider";
import { PageHeader } from "@/components/PageHeader";
import { OverallBanner } from "@/components/OverallBanner";
import { StatCard } from "@/components/StatCard";
import { SiteCard } from "@/components/SiteCard";
import { CardGridSkeleton, EmptyState, ErrorState } from "@/components/States";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { uptimePct, uptimeColor } from "@/lib/format";
import { useLayoutSearch } from "@/components/AppLayout";
import { overallStatus } from "@pulse/shared";

export default function Overview() {
  const { data, error, loading, reload } = useSummary();
  const auth = useAuth();
  const search = useLayoutSearch();
  const [group, setGroup] = useState<string>("all");

  useBrand(data?.brand);

  const visibleSites = useMemo(
    () => (data ? scopedSites(auth.scope, data.sites) : []),
    [data, auth.scope],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleSites.filter((s) => {
      if (group !== "all" && s.group !== group) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.url.toLowerCase().includes(q) ||
        (s.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [visibleSites, search, group]);

  // Recompute KPIs over the scoped (visible) set so CLIENT/VIEWER see their own.
  const totals = useMemo(() => {
    const up = visibleSites.filter((s) => !s.paused && s.status === "up").length;
    const down = visibleSites.filter((s) => !s.paused && s.status === "down").length;
    const degraded = visibleSites.filter((s) => !s.paused && s.status === "degraded").length;
    const active = visibleSites.filter((s) => !s.paused);
    const uptime =
      active.length > 0
        ? active.reduce((acc, s) => acc + s.uptime24h, 0) / active.length
        : null;
    return { sites: visibleSites.length, up, down, degraded, uptime };
  }, [visibleSites]);

  const overall = useMemo(
    () =>
      overallStatus(
        visibleSites.filter((s) => !s.paused).map((s) => s.status),
      ),
    [visibleSites],
  );

  const groups = useMemo(() => {
    if (!data) return [];
    const visibleGroupIds = new Set(visibleSites.map((s) => s.group).filter(Boolean));
    return data.groups.filter((g) => visibleGroupIds.has(g.id));
  }, [data, visibleSites]);

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Overview" description="Live health across every monitored target." />
        <Skeleton className="h-20 w-full rounded-xl" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <CardGridSkeleton />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="Overview" />
        <ErrorState message={error.message} onRetry={reload} />
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        description="Live health across every monitored target."
      />

      <OverallBanner status={overall} generatedAt={data.generatedAt} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
        <StatCard label="Total sites" value={totals.sites} icon={<Activity className="size-5" />} />
        <StatCard
          label="Up"
          value={totals.up}
          tone="text-up"
          icon={<ArrowUpCircle className="size-5 text-up" />}
        />
        <StatCard
          label="Down"
          value={totals.down}
          tone={totals.down > 0 ? "text-down" : undefined}
          icon={<ArrowDownCircle className="size-5 text-down" />}
        />
        <StatCard
          label="Degraded"
          value={totals.degraded}
          tone={totals.degraded > 0 ? "text-degraded" : undefined}
          icon={<AlertTriangle className="size-5 text-degraded" />}
        />
        <StatCard
          label="Uptime (24h)"
          value={uptimePct(totals.uptime)}
          tone={uptimeColor(totals.uptime)}
          icon={<Gauge className="size-5" />}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold tracking-tight">
          Sites
          {filtered.length !== visibleSites.length && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              {filtered.length} of {visibleSites.length}
            </span>
          )}
        </h2>
        {groups.length > 0 && (
          <Select value={group} onValueChange={setGroup}>
            <SelectTrigger className="w-full sm:w-52">
              <SelectValue placeholder="All groups" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All groups</SelectItem>
              {groups.map((g) => (
                <SelectItem key={g.id} value={g.id}>
                  {g.icon ? `${g.icon} ${g.name}` : g.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={search ? "No sites match your search" : "No sites to show"}
          hint={
            search
              ? "Try a different name, URL, or tag."
              : "Add sites to pulse.config.yaml in the repo to start monitoring."
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((site) => (
            <SiteCard key={site.id} site={site} />
          ))}
        </div>
      )}
    </div>
  );
}
