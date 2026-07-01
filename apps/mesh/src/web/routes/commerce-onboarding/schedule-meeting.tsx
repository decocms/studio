import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowUpRight, ChevronDown, User01 } from "@untitledui/icons";
import { useState } from "react";

/**
 * Where "Schedule a meeting" sends people who'd rather have us run the
 * diagnostic live, don't have access to their tools yet, or aren't ready to
 * grant it. Books onto the deco commerce team calendar. Swap the URL to
 * repoint the calendar.
 */
const SCHEDULE_MEETING_URL =
  "https://decocms-tanstack.deco-cx.workers.dev/agendar";

const HEADLINE = "Rather have us walk you through it?";
const BODY =
  "Book a 20-minute call and we'll run the diagnostic with you, live.";

function ScheduleMeetingCta({
  size = "lg",
  className,
}: {
  size?: "lg" | "xl";
  className?: string;
}) {
  return (
    <Button
      asChild
      variant="outline"
      size={size}
      className={cn("w-full", className)}
    >
      <a href={SCHEDULE_MEETING_URL} target="_blank" rel="noreferrer">
        Schedule a meeting
        <ArrowUpRight size={16} />
      </a>
    </Button>
  );
}

function ConnectionNode({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-10 flex h-12 w-12 items-center justify-center rounded-full border border-border bg-card card-shadow">
      {children}
    </div>
  );
}

/**
 * Animated "you → deco" connection: two nodes joined by a hairline wire with a
 * dot travelling across it and a ring blooming from the deco end as it lands.
 * Kept monochrome so the green deco mark is the only spot of colour.
 */
function ConnectionAnimation() {
  return (
    <div className="flex items-center justify-between rounded-2xl border border-border/60 bg-muted/40 px-7 py-7">
      <ConnectionNode>
        <User01 size={20} className="text-muted-foreground" />
      </ConnectionNode>

      {/* Hairline wire + travelling dot */}
      <div className="relative mx-4 h-px flex-1 bg-border">
        <span
          className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground animate-connection-travel"
          aria-hidden
        />
      </div>

      <div className="relative">
        <span
          className="absolute inset-0 rounded-full border border-foreground/40 animate-connection-arrive"
          aria-hidden
        />
        <ConnectionNode>
          <img
            src="/logos/deco logo.svg"
            alt="deco"
            className="h-6 w-6 dark:hidden"
          />
          <img
            src="/logos/deco logo negative.svg"
            alt="deco"
            className="hidden h-6 w-6 dark:block"
          />
        </ConnectionNode>
      </div>
    </div>
  );
}

/**
 * Right-hand panel for the commerce onboarding split screen (md+ only, it lives
 * in the AuthSplitLayout `visual` slot). The "or" to the connect-your-tools
 * flow on the left: a human escape hatch for people who resist granting access.
 */
export function ScheduleMeetingVisual() {
  return (
    <div className="relative flex h-full w-full items-center justify-center p-10">
      <div className="flex w-full max-w-[380px] flex-col gap-6 rounded-3xl border border-border bg-card p-8 card-shadow">
        <ConnectionAnimation />
        <div className="grid gap-2">
          <h2 className="text-xl font-medium leading-7 text-foreground">
            {HEADLINE}
          </h2>
          <p className="text-base leading-6 text-muted-foreground">{BODY}</p>
        </div>
        <ScheduleMeetingCta size="xl" />
      </div>
    </div>
  );
}

/**
 * Mobile counterpart of {@link ScheduleMeetingVisual}. On small screens the
 * split disappears and connecting tools is the priority, so this collapses to a
 * quiet row that expands to reveal the call CTA on tap.
 */
export function ScheduleMeetingBanner({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={cn("rounded-2xl border border-border bg-card", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 p-4 text-left"
      >
        <span className="flex items-center gap-2.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <User01 size={14} />
          </span>
          <span className="text-sm font-medium text-foreground">
            Prefer to talk to a human?
          </span>
        </span>
        <ChevronDown
          size={18}
          className={cn(
            "text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="grid gap-3 px-4 pb-4">
          <p className="text-sm leading-5 text-muted-foreground">{BODY}</p>
          <ScheduleMeetingCta />
        </div>
      )}
    </div>
  );
}
