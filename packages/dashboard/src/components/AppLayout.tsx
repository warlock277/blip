import { useState } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import {
  LayoutDashboard,
  ListChecks,
  AlertOctagon,
  Globe,
  Settings,
  Search,
  Menu,
  X,
  ExternalLink,
  LogOut,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { useAuth, ROLE_LABEL } from "@/lib/auth";
import { useSummary } from "@/lib/data";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
}

const NAV: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard, end: true },
  { to: "/sites", label: "Sites", icon: ListChecks },
  { to: "/incidents", label: "Incidents", icon: AlertOctagon },
  { to: "/status", label: "Status page", icon: Globe },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** Shared layout context — exposes the global search query to child routes. */
export interface LayoutContext {
  search: string;
}

export function useLayoutSearch(): string {
  return useOutletContext<LayoutContext>().search;
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )
          }
        >
          <Icon className="size-4" />
          {label}
          {to === "/status" && <ExternalLink className="ml-auto size-3.5 opacity-60" />}
        </NavLink>
      ))}
    </nav>
  );
}

function UserChip() {
  const auth = useAuth();
  const label = auth.label ?? "Signed-in user";
  const initial = (label[0] ?? "P").toUpperCase();
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2">
      <div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{label}</p>
        {auth.role && (
          <Badge variant="muted" className="mt-0.5 px-1.5 py-0 text-[10px]">
            {ROLE_LABEL[auth.role]}
          </Badge>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => void auth.logout()}
        aria-label="Log out"
        title="Log out"
      >
        <LogOut className="size-4" />
      </Button>
    </div>
  );
}

/** Admin app shell: fixed left sidebar + sticky topbar with global search. */
export function AppLayout() {
  const [search, setSearch] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const { data: summary } = useSummary();
  const brandName = summary?.brand?.name;

  return (
    <div className="flex min-h-full bg-background">
      {/* Sidebar (desktop) */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-card/40 p-4 lg:flex">
        <div className="px-2 pb-6 pt-1">
          <Logo name={brandName} />
        </div>
        <NavItems />
        <div className="mt-auto">
          <UserChip />
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col border-r border-border bg-card p-4 shadow-xl animate-in slide-in-from-left">
            <div className="flex items-center justify-between px-2 pb-6 pt-1">
              <Logo name={brandName} />
              <Button variant="ghost" size="icon" onClick={() => setMobileOpen(false)}>
                <X className="size-4" />
              </Button>
            </div>
            <NavItems onNavigate={() => setMobileOpen(false)} />
            <div className="mt-auto">
              <UserChip />
            </div>
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </Button>
          <div className="relative w-full max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sites…"
              className="pl-9"
            />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <ThemeToggle />
          </div>
        </header>

        <main className="flex-1 px-4 py-6 lg:px-6 lg:py-8">
          <div className="mx-auto w-full max-w-7xl animate-fade-in">
            <Outlet context={{ search } satisfies LayoutContext} />
          </div>
        </main>
      </div>
    </div>
  );
}
