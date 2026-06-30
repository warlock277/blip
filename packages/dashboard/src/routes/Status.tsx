import { useMemo, useState } from "react";
import type { GroupSummary, SiteSummary } from "@blip/shared";
import { overallStatus } from "@blip/shared";
import { ExternalLink, Heart, LogIn, LogOut } from "lucide-react";
import { useSummary } from "@/lib/data";
import { useAuth } from "@/lib/auth";
import { useBrand } from "@/components/BrandProvider";
import { LoginScreen } from "@/components/LoginScreen";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { OverallBanner } from "@/components/OverallBanner";
import { StatusBadge } from "@/components/StatusBadge";
import { UptimeBar } from "@/components/UptimeBar";
import { IncidentRow } from "@/components/IncidentRow";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/States";
import {
  uptimePct,
  uptimeColor,
  siteDisplayStatus,
  relativeTime,
} from "@/lib/format";

function StatusSiteRow({ site }: { site: SiteSummary }) {
  return (
    <div className="px-4 py-4 sm:px-5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-medium">{site.name}</p>
          {site.description && (
            <p className="truncate text-sm text-muted-foreground">{site.description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className={uptimeColor(site.uptime90d) + " text-sm font-medium tabular-nums"}>
            {uptimePct(site.uptime90d, 2)}
          </span>
          <StatusBadge status={siteDisplayStatus(site)} />
        </div>
      </div>
      <div className="mt-3">
        <UptimeBar spark={site.spark} days={90} className="h-7" showLegend />
      </div>
    </div>
  );
}

function GroupSection({
  group,
  sites,
}: {
  group: GroupSummary | null;
  sites: SiteSummary[];
}) {
  if (sites.length === 0) return null;
  return (
    <Card className="overflow-hidden">
      {group && (
        <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-3 sm:px-5">
          {group.icon && <span aria-hidden>{group.icon}</span>}
          <h2 className="font-semibold tracking-tight">{group.name}</h2>
          {group.description && (
            <span className="text-sm text-muted-foreground">— {group.description}</span>
          )}
        </div>
      )}
      <CardContent className="divide-y divide-border p-0">
        {sites.map((s) => (
          <StatusSiteRow key={s.id} site={s} />
        ))}
      </CardContent>
    </Card>
  );
}

export default function Status() {
  const { data, error, loading, reload, unauthorized } = useSummary();
  const auth = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  useBrand(data?.brand);

  const publicSites = useMemo(
    () => (data ? data.sites.filter((s) => s.public !== false) : []),
    [data],
  );

  const overall = useMemo(
    () => overallStatus(publicSites.filter((s) => !s.paused).map((s) => s.status)),
    [publicSites],
  );

  const sections = useMemo(() => {
    if (!data) return [];
    const byId = new Map(publicSites.map((s) => [s.id, s]));
    const out: { group: GroupSummary | null; sites: SiteSummary[] }[] = [];
    const grouped = new Set<string>();

    for (const g of data.groups) {
      const sites = g.siteIds.map((id) => byId.get(id)).filter((s): s is SiteSummary => !!s);
      sites.forEach((s) => grouped.add(s.id));
      if (sites.length > 0) out.push({ group: g, sites });
    }
    const ungrouped = publicSites.filter((s) => !grouped.has(s.id));
    if (ungrouped.length > 0) out.push({ group: null, sites: ungrouped });
    return out;
  }, [data, publicSites]);

  const activeIncidents = useMemo(
    () =>
      (data?.incidents ?? []).filter(
        (i) => i.state === "open" && publicSites.some((s) => s.id === i.siteId),
      ),
    [data, publicSites],
  );

  const brand = data?.brand;
  const brandName = brand?.name?.trim() || "Blip";

  // The Worker returned 401 for /data/summary.json (status page not public and
  // viewer not logged in) or the viewer asked to sign in → show the login card.
  if ((unauthorized && !auth.authenticated) || showLogin) {
    return <LoginScreen brandName={brandName} onSuccess={() => setShowLogin(false)} />;
  }

  return (
    <div className="flex min-h-full flex-col bg-background">
      {/* Minimal branded topbar (no sidebar) */}
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between px-4 py-4 sm:px-6">
          <Logo name={brandName} logoUrl={brand?.logoUrl} />
          <div className="flex items-center gap-1">
            {brand?.website && (
              <a
                href={brand.website}
                target="_blank"
                rel="noreferrer"
                className="hidden items-center gap-1 text-sm text-muted-foreground hover:text-primary sm:inline-flex"
              >
                Website <ExternalLink className="size-3.5" />
              </a>
            )}
            {auth.authenticated ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void auth.logout()}
                className="text-muted-foreground"
              >
                <LogOut className="size-3.5" /> Sign out
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowLogin(true)}
                className="text-muted-foreground"
              >
                <LogIn className="size-3.5" /> Sign in
              </Button>
            )}
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="bg-grid flex-1">
        <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6 sm:py-12">
          {loading ? (
            <div className="space-y-6">
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-48 w-full rounded-xl" />
              <Skeleton className="h-48 w-full rounded-xl" />
            </div>
          ) : error && !data ? (
            <ErrorState
              title="Status temporarily unavailable"
              message={error.message}
              onRetry={reload}
            />
          ) : !data ? null : (
            <div className="space-y-8 animate-fade-in">
              {/* Hero */}
              <div className="text-center">
                <h1 className="text-3xl font-bold tracking-tight">{brandName} Status</h1>
                {brand?.tagline && (
                  <p className="mx-auto mt-2 max-w-xl text-balance text-muted-foreground">
                    {brand.tagline}
                  </p>
                )}
              </div>

              <OverallBanner status={overall} generatedAt={data.generatedAt} hero />

              {/* Active incidents */}
              {activeIncidents.length > 0 && (
                <section className="space-y-3">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                    Active incidents
                  </h2>
                  {activeIncidents.map((inc) => (
                    <IncidentRow key={inc.id} incident={inc} />
                  ))}
                </section>
              )}

              {/* Components by group */}
              {sections.length === 0 ? (
                <EmptyState title="No public components" hint="Nothing is published yet." />
              ) : (
                <section className="space-y-5">
                  {sections.map((s, i) => (
                    <GroupSection key={s.group?.id ?? `ungrouped-${i}`} group={s.group} sites={s.sites} />
                  ))}
                </section>
              )}

              <p className="text-center text-xs text-muted-foreground">
                Last updated {relativeTime(data.generatedAt)}
              </p>
            </div>
          )}
        </div>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
          <span className="inline-flex items-center gap-1.5">
            Powered by{" "}
            <a
              href="https://github.com/warlock277/blip"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
            >
              <Heart className="size-3.5 fill-primary text-primary" /> Blip
            </a>
          </span>
          {brand?.supportUrl && (
            <a href={brand.supportUrl} className="hover:text-primary" target="_blank" rel="noreferrer">
              Support
            </a>
          )}
        </div>
      </footer>
    </div>
  );
}
