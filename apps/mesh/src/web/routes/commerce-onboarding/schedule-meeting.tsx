import { track } from "@/web/lib/posthog-client";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ArrowUpRight } from "@untitledui/icons";

type MeetingCtaPlacement = "visual_card" | "mobile_banner";

/**
 * Where "Schedule a meeting" sends people who'd rather have us run the
 * diagnostic live, don't have access to their tools yet, or aren't ready to
 * grant it. Books onto the deco commerce team calendar. Swap the URL to
 * repoint the calendar.
 */
const SCHEDULE_MEETING_URL = "https://decocms.com/agendar";

const HEADLINE = "Precisa de ajuda? Fale conosco";
const BODY =
  "Agende uma chamada de 20 minutos e ajudamos você a conectar suas ferramentas.";

const TEAM = [
  {
    photo:
      "https://decoims.com/image?src=decocms%2Fb07a1c19-0cd6-49c8-b326-86055ee78605%2Fauthor-1763423987973-baby.jpeg&quality=original&fit=cover&width=200&height=200",
    alt: "Especialista da deco",
  },
  {
    photo:
      "https://decoims.com/decocms/07c2daf4-a3c2-485e-a1a8-341585a06e3b/cecilia.png",
    alt: "Especialista da deco",
  },
  {
    photo:
      "https://decoims.com/decocms/48013ca2-3277-464b-b0f1-dd5f1f08d986/tavano.png",
    alt: "Especialista da deco",
  },
] as const;

const GREEN_DARK = "var(--brand-green-dark)";

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
  orgId,
}: {
  href?: string;
  size?: "lg" | "xl";
  className?: string;
  orgId?: string;
}) {
  return (
    // Same style as the left-side "Conectar" buttons (outline) for consistency
    // across the onboarding screen.
    <Button
      asChild
      variant="outline"
      size={size}
      className={cn("w-full", className)}
    >
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={() =>
          track("commerce_onboarding_meeting_cta_clicked", {
            placement: "visual_card" satisfies MeetingCtaPlacement,
            organization_id: orgId,
          })
        }
      >
        Agendar uma reunião
        <ArrowUpRight size={16} />
      </a>
    </Button>
  );
}

function TeamAvatars({ size = 72 }: { size?: number }) {
  const overlap = Math.round(size * 0.3);
  return (
    <div className="flex items-end" style={{ height: size }}>
      {TEAM.map((member, i) => (
        <div
          key={member.photo}
          className="relative shrink-0"
          style={{
            width: size,
            height: size,
            marginLeft: i === 0 ? 0 : -overlap,
            zIndex: TEAM.length - i,
          }}
        >
          <div className="h-full w-full overflow-hidden rounded-full border-4 border-card bg-muted">
            <img
              src={member.photo}
              alt={member.alt}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </div>
          {i === 0 && (
            <span className="absolute bottom-1.5 right-1.5 flex h-3.5 w-3.5">
              <span
                className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping"
                aria-hidden
              />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-card bg-success" />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Right-hand panel for the commerce onboarding split screen (md+ only, it lives
 * in the AuthSplitLayout `visual` slot). The "or" to the connect-your-tools
 * flow on the left: a human escape hatch for people who resist granting access.
 *
 * Structured like a "meet your specialist" card: a solid deco-green header band
 * carries the brand colour and the host's face overlaps it, with a clean
 * left-aligned body below. Green is the solid band, never a gradient wash.
 */
export function ScheduleMeetingVisual({
  href,
  orgId,
}: {
  href?: string;
  orgId?: string;
}) {
  return (
    <div className="relative flex h-full w-full items-center justify-center p-10">
      {/* Bigger footprint (wide card + generous padding); content stays at its
          normal scale. */}
      <div className="w-full max-w-[440px] overflow-hidden rounded-3xl border border-border bg-card card-shadow">
        {/* Solid brand-green header band */}
        <div className="h-20" style={{ backgroundColor: GREEN_DARK }} />

        <div className="px-8 pb-8">
          {/* Team overlaps the band */}
          <div className="-mt-9 mb-4">
            <TeamAvatars />
          </div>

          <div className="grid gap-1.5">
            <h2 className="text-lg font-medium leading-6 text-foreground">
              {HEADLINE}
            </h2>
            <p className="text-sm leading-5 text-muted-foreground">{BODY}</p>
          </div>

          <ScheduleMeetingCta
            href={href}
            size="lg"
            className="mt-6"
            orgId={orgId}
          />
        </div>
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
  orgId,
}: {
  className?: string;
  href?: string;
  orgId?: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={() =>
        track("commerce_onboarding_meeting_cta_clicked", {
          placement: "mobile_banner" satisfies MeetingCtaPlacement,
          organization_id: orgId,
        })
      }
      className={cn(
        "flex items-center gap-3 rounded-xl border border-border bg-card p-3 card-shadow transition-colors hover:bg-accent",
        className,
      )}
    >
      <span
        className="relative flex shrink-0 items-center"
        style={{ height: 32, width: 32 + 2 * Math.round(32 * 0.7) }}
      >
        {TEAM.map((member, i) => (
          <span
            key={member.photo}
            className="absolute block h-8 w-8 overflow-hidden rounded-full border-2 border-card"
            style={{ left: i * Math.round(32 * 0.7), zIndex: TEAM.length - i }}
          >
            <img
              src={member.photo}
              alt={member.alt}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </span>
        ))}
        <span
          className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-card bg-success"
          aria-hidden
          style={{ zIndex: TEAM.length + 1 }}
        />
      </span>
      {/* Mobile-only banner: compact single line (the desktop
          ScheduleMeetingVisual keeps the full headline + description). */}
      <span className="flex-1 text-sm font-medium leading-tight text-foreground">
        Precisa de ajuda? Fale conosco
      </span>
      <ArrowUpRight size={16} className="shrink-0 text-muted-foreground" />
    </a>
  );
}
