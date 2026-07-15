/**
 * Source icons for the demo board. GA4 and Search Console icons come from
 * the app registry at runtime in the real product, so the demo inlines
 * minimal brand marks instead. GitHub reuses the existing shared icon.
 */

import { cn } from "@deco/ui/lib/utils.ts";
import { GitHubIcon } from "@/web/components/icons/github-icon";
import type { DemoSource } from "./data";

function Ga4Icon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
    >
      <rect x="16.6" y="3" width="4.4" height="18" rx="2.2" fill="#F9AB00" />
      <rect x="9.8" y="10" width="4.4" height="11" rx="2.2" fill="#E37400" />
      <circle cx="5.2" cy="18.8" r="2.2" fill="#E37400" />
    </svg>
  );
}

function SearchConsoleIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
    >
      <rect x="2" y="4" width="20" height="16" rx="3" fill="#4285F4" />
      <rect x="2" y="4" width="20" height="5" rx="2.5" fill="#669DF6" />
      <rect x="6" y="12.5" width="3" height="5" rx="1" fill="#fff" />
      <rect x="10.5" y="11" width="3" height="6.5" rx="1" fill="#fff" />
      <rect x="15" y="13.5" width="3" height="4" rx="1" fill="#fff" />
    </svg>
  );
}

export function SourceIcon({
  source,
  size = 14,
  className,
}: {
  source: DemoSource;
  size?: number;
  className?: string;
}) {
  switch (source) {
    case "ga4":
      return <Ga4Icon size={size} className={className} />;
    case "gsc":
      return <SearchConsoleIcon size={size} className={className} />;
    case "github":
      return (
        <GitHubIcon size={size} className={cn("text-foreground", className)} />
      );
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

/** Small dark avatar for the Deco agent. */
export function DecoAvatar({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full bg-foreground text-[9px] font-semibold text-background",
        className,
      )}
      aria-label="Deco"
    >
      D
    </span>
  );
}
