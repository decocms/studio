import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowUpRight, User01 } from "@untitledui/icons";

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

/**
 * Build the scheduling link, prefilling the site under diagnosis and the
 * signed-in user's email as query params so the booking page arrives with
 * context (both omitted when unknown).
 */
export function buildScheduleMeetingUrl({
  siteUrl,
  email,
}: {
  siteUrl?: string | null;
  email?: string | null;
}): string {
  const url = new URL(SCHEDULE_MEETING_URL);
  if (siteUrl) url.searchParams.set("siteUrl", siteUrl);
  if (email) url.searchParams.set("email", email);
  return url.toString();
}

function ScheduleMeetingCta({
  href = SCHEDULE_MEETING_URL,
  size = "lg",
  className,
}: {
  href?: string;
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
      <a href={href} target="_blank" rel="noreferrer">
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
export function ScheduleMeetingVisual({ href }: { href?: string }) {
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
        <ScheduleMeetingCta href={href} size="xl" />
      </div>
    </div>
  );
}

/**
 * Mobile counterpart of {@link ScheduleMeetingVisual}. On small screens the
 * split disappears, so this is a compact, tappable banner that opens the
 * scheduling flow directly — quieter than the full card, still inviting.
 */
export function ScheduleMeetingBanner({
  className,
  href = SCHEDULE_MEETING_URL,
}: {
  className?: string;
  href?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "flex items-center gap-4 rounded-2xl border border-border bg-card p-5 card-shadow transition-colors hover:bg-accent",
        className,
      )}
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <User01 size={20} />
      </span>
      <span className="flex flex-1 flex-col gap-0.5">
        <span className="text-base font-medium leading-5 text-foreground">
          Prefer to talk to a human?
        </span>
        <span className="text-sm leading-5 text-muted-foreground">
          Book a call and we'll run the diagnostic with you.
        </span>
      </span>
      <ArrowUpRight size={18} className="shrink-0 text-muted-foreground" />
    </a>
  );
}
