import { useMemo } from "react";
import {
  ExternalLink,
  Github,
  Info,
  Palette,
  Shield,
  Bell,
  Send,
  Mail,
  MessageSquare,
  Webhook,
} from "lucide-react";
import type { ChannelType, Role } from "@pulse/shared";
import { useSummary } from "@/lib/data";
import { useBrand } from "@/components/BrandProvider";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth, ROLE_LABEL, ROLE_DESCRIPTION } from "@/lib/auth";
import { cn } from "@/lib/utils";

const ROLES: Role[] = ["SUPER_ADMIN", "ADMIN", "CLIENT", "VIEWER"];

const CHANNEL_ICON: Record<ChannelType, typeof Send> = {
  telegram: Send,
  email: Mail,
  discord: MessageSquare,
  slack: MessageSquare,
  webhook: Webhook,
};

/**
 * Derive notification channel summaries from data we already have.
 *
 * The summary intentionally never exposes channel configs (which contain
 * secrets), so we infer the *types* of channels in use from incident/site
 * routing where possible. When nothing can be derived we show guidance instead
 * of inventing data — and we NEVER render secrets.
 */
function useDerivedChannels(): { type: ChannelType; label: string }[] {
  // No secret-free channel list is published in summary.json by design.
  // Show the supported channel kinds as informational chips.
  return useMemo(
    () => [
      { type: "telegram", label: "Telegram" },
      { type: "email", label: "Email (Resend)" },
      { type: "discord", label: "Discord" },
      { type: "slack", label: "Slack" },
      { type: "webhook", label: "Webhook" },
    ],
    [],
  );
}

export default function Settings() {
  const { data, loading } = useSummary();
  const auth = useAuth();
  const channels = useDerivedChannels();

  useBrand(data?.brand);

  const brand = data?.brand;

  const scopeSummary = useMemo(() => {
    const scope = auth.scope;
    if (scope == null || scope === "all") return "all sites and groups";
    const parts: string[] = [];
    if (scope.groups.length > 0) {
      parts.push(`${scope.groups.length} group${scope.groups.length === 1 ? "" : "s"} (${scope.groups.join(", ")})`);
    }
    if (scope.sites.length > 0) {
      parts.push(`${scope.sites.length} site${scope.sites.length === 1 ? "" : "s"} (${scope.sites.join(", ")})`);
    }
    return parts.length > 0 ? parts.join(" + ") : "no sites";
  }, [auth.scope]);

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Read-only overview of how this workspace is configured."
      />

      <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        <Info className="-mt-0.5 mr-1.5 inline size-4" />
        Configuration is edited in the repository (
        <code className="rounded bg-background px-1 py-0.5 text-xs">pulse.config.yaml</code>), not
        here. Commit a change and the next monitoring run picks it up.
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Brand */}
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Palette className="size-4 text-muted-foreground" />
            <CardTitle>Branding</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-24 w-full" />
            ) : (
              <dl className="space-y-2.5 text-sm">
                <Row label="Name" value={brand?.name ?? "Pulse"} />
                <Row label="Tagline" value={brand?.tagline ?? "—"} />
                <Row
                  label="Accent"
                  value={
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="size-4 rounded-full border border-border"
                        style={{ background: brand?.primaryColor ?? "hsl(var(--primary))" }}
                      />
                      <code className="text-xs">{brand?.primaryColor ?? "default"}</code>
                    </span>
                  }
                />
                {brand?.website && (
                  <Row
                    label="Website"
                    value={
                      <a
                        href={brand.website}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        {brand.website} <ExternalLink className="size-3" />
                      </a>
                    }
                  />
                )}
              </dl>
            )}
          </CardContent>
        </Card>

        {/* Notification channels */}
        <Card>
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Bell className="size-4 text-muted-foreground" />
            <CardTitle>Notification channels</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <CardDescription>
              Supported alert channels. Tokens and webhook URLs live only in repo secrets and are
              never shown in the dashboard.
            </CardDescription>
            <ul className="flex flex-wrap gap-2">
              {channels.map((c) => {
                const Icon = CHANNEL_ICON[c.type];
                return (
                  <li key={c.type}>
                    <Badge variant="secondary" className="gap-1.5 py-1">
                      <Icon className="size-3.5" />
                      {c.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>

        {/* Roles */}
        <Card className="lg:col-span-2">
          <CardHeader className="flex-row items-center gap-2 space-y-0">
            <Shield className="size-4 text-muted-foreground" />
            <CardTitle>Roles &amp; access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <CardDescription>
              You are signed in as{" "}
              <span className="font-medium text-foreground">{auth.label ?? "a user"}</span>
              {auth.role && (
                <>
                  {" "}
                  with the{" "}
                  <span className="font-medium text-foreground">{ROLE_LABEL[auth.role]}</span> role
                </>
              )}
              . Your scope is{" "}
              <span className="font-medium text-foreground">{scopeSummary}</span>. Access is
              configured in{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">pulse.config.yaml</code> under{" "}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">access.principals</code>, with
              passwords stored as Cloudflare Worker secrets. The Worker enforces access at the edge
              and filters all data server-side — the roles below only shape what the UI reveals.
            </CardDescription>
            <ul className="grid gap-3 sm:grid-cols-2">
              {ROLES.map((r) => (
                <li
                  key={r}
                  className={cn(
                    "rounded-lg border border-border p-3",
                    r === auth.role && "border-primary/40 bg-primary/5",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{ROLE_LABEL[r]}</span>
                    {r === auth.role && (
                      <Badge variant="default" className="px-1.5 py-0 text-[10px]">
                        You
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{ROLE_DESCRIPTION[r]}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3 text-sm">
        <a
          href="https://github.com/pulse/pulse"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 font-medium hover:bg-accent"
        >
          <Github className="size-4" /> Source &amp; docs
          <ExternalLink className="size-3.5 opacity-60" />
        </a>
        <span className="text-muted-foreground">
          Edit <code className="rounded bg-muted px-1 py-0.5 text-xs">docs/configuration.md</code>{" "}
          for the full reference.
        </span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
