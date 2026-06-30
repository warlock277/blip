import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import {
  AuthContext,
  fetchMe,
  postLogin,
  postLogout,
  type AuthContextValue,
  type AuthMe,
  type LoginResult,
} from "@/lib/auth";

const ANON: AuthMe = { authenticated: false, publicStatusPage: false };

/**
 * Resolves the Worker session on mount (`GET /auth/me`) and exposes login /
 * logout. Shows a full-page spinner until the first resolution completes.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthMe>(ANON);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void fetchMe().then((next) => {
      if (active) {
        setMe(next);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (password: string): Promise<LoginResult> => {
    const result = await postLogin(password);
    if (result.ok && result.me) setMe(result.me);
    return result;
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    await postLogout();
    setMe(ANON);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      authenticated: me.authenticated,
      role: me.role,
      label: me.label,
      scope: me.scope,
      publicStatusPage: me.publicStatusPage,
      publicDashboard: me.publicDashboard ?? false,
      loading,
      login,
      logout,
    }),
    [me, loading, login, logout],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
