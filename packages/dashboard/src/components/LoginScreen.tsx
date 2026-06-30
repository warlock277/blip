import { useState, type FormEvent } from "react";
import { Loader2, LogIn } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { useAuth } from "@/lib/auth";

interface LoginScreenProps {
  /** Brand name for the card heading. Defaults to "Pulse". */
  brandName?: string;
  /** Optional callback after a successful login (e.g. to dismiss an overlay). */
  onSuccess?: () => void;
}

/** Branded, centered password-login card. Renders when auth is required. */
export function LoginScreen({ brandName = "Pulse", onSuccess }: LoginScreenProps) {
  const { login } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting || !password) return;
    setSubmitting(true);
    setError(null);
    const result = await login(password);
    setSubmitting(false);
    if (result.ok) {
      setPassword("");
      onSuccess?.();
      return;
    }
    setError(
      result.wrongPassword
        ? "Incorrect password. Please try again."
        : "Unable to sign in. Please try again.",
    );
  }

  return (
    <div className="bg-grid flex min-h-screen flex-col items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Logo name={brandName} className="mb-2" />
          <CardTitle className="text-lg">Sign in</CardTitle>
          <CardDescription>Enter your password to access the dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-3" noValidate>
            <div className="space-y-1.5">
              <label htmlFor="password" className="text-sm font-medium">
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoFocus
                autoComplete="current-password"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                disabled={submitting}
                aria-invalid={error != null}
                aria-describedby={error ? "password-error" : undefined}
                placeholder="••••••••"
              />
            </div>
            {error && (
              <p id="password-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting || !password}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <LogIn className="size-4" />
              )}
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="mt-6 text-xs text-muted-foreground">
        Access is configured in <code className="text-foreground">pulse.config.yaml</code>.
      </p>
    </div>
  );
}
