import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  /** Optional brand logo URL; falls back to the built-in heartbeat mark. */
  logoUrl?: string;
  name?: string;
}

/** Pulse heartbeat mark + wordmark. Uses brand logo when provided. */
export function Logo({ className, logoUrl, name = "Pulse" }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {logoUrl ? (
        <img src={logoUrl} alt={name} className="size-7 rounded-md object-contain" />
      ) : (
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
            <path
              d="M5 16.5h4.2l2.1-6.3 3.6 11.4 3-9 2 3.9H27"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      )}
      <span className="text-base font-semibold tracking-tight">{name}</span>
    </div>
  );
}
