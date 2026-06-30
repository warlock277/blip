import { cn } from "@/lib/utils";

interface LogoProps {
  className?: string;
  /** Optional brand logo URL; falls back to the built-in heartbeat mark. */
  logoUrl?: string;
  name?: string;
}

/** Blip heartbeat mark + wordmark. Uses brand logo when provided. */
export function Logo({ className, logoUrl, name = "Blip" }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      {logoUrl ? (
        <img src={logoUrl} alt={name} className="size-7 rounded-md object-contain" />
      ) : (
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm">
          {/* Radar "blip": a dot emitting two signal arcs. */}
          <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M10.6 19.2a7.2 7.2 0 0 1 10.8 0" />
              <path d="M6.8 14.8a12.8 12.8 0 0 1 18.4 0" />
            </g>
            <circle cx="16" cy="22.4" r="2.7" fill="currentColor" />
          </svg>
        </span>
      )}
      <span className="text-base font-semibold tracking-tight">{name}</span>
    </div>
  );
}
