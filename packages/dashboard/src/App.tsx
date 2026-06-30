import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/components/AuthProvider";
import { AppLayout } from "@/components/AppLayout";
import { LoginScreen } from "@/components/LoginScreen";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import Overview from "@/routes/Overview";
import Sites from "@/routes/Sites";
import Incidents from "@/routes/Incidents";
import Settings from "@/routes/Settings";
import NotFound from "@/routes/NotFound";

// Lazy-load the chart-heavy detail page + the standalone status page so the
// recharts bundle is only fetched when actually needed.
const SiteDetail = lazy(() => import("@/routes/SiteDetail"));
const Status = lazy(() => import("@/routes/Status"));

function RouteFallback() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-80 w-full rounded-xl" />
    </div>
  );
}

/**
 * Gate for the admin shell. Requires an authenticated session, EXCEPT when
 * `allowPublic` is set and the workspace enables `publicDashboard` — then
 * anonymous viewers get the read-only dashboard (the Worker scopes their data
 * to public sites). When neither holds, the LoginScreen renders inline.
 */
function RequireAuth({ children, allowPublic = false }: { children: ReactNode; allowPublic?: boolean }) {
  const { authenticated, publicDashboard } = useAuth();
  if (!authenticated && !(allowPublic && publicDashboard)) return <LoginScreen />;
  return <>{children}</>;
}

/**
 * The public status page: visible to anonymous viewers when the workspace
 * publishes a public status page, or to anyone authenticated. Otherwise the
 * LoginScreen is shown.
 */
function PublicStatus() {
  const { authenticated, publicStatusPage } = useAuth();
  if (!publicStatusPage && !authenticated) return <LoginScreen />;
  return <Status />;
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            {/* Public status page — standalone minimal layout, no sidebar. */}
            <Route path="/status" element={<PublicStatus />} />

            {/* Dashboard shell. Read-only routes allow anonymous viewers when
                `publicDashboard` is on; Settings always requires a login. */}
            <Route
              element={
                <RequireAuth allowPublic>
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Overview />} />
              <Route path="sites" element={<Sites />} />
              <Route path="sites/:id" element={<SiteDetail />} />
              <Route path="incidents" element={<Incidents />} />
              <Route
                path="settings"
                element={
                  <RequireAuth>
                    <Settings />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
