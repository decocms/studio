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
  "Agende uma chamada de 20 minutos e rodamos o diagnóstico com você, ao vivo.";

/**
 * The deco commerce specialist who runs these live diagnostics — a real face
 * makes the "book a call" feel like a call, not an abstraction. Swap `name`/
 * `role` to whoever staffs the calendar.
 */
const HOST = {
  photo:
    "https://decoims.com/image?src=decocms%2Fb07a1c19-0cd6-49c8-b326-86055ee78605%2Fauthor-1763423987973-baby.jpeg&quality=original&fit=cover&width=200&height=200",
} as const;

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

/**
 * The host's face with a single live-availability dot (DS success green), tucked
 * against the avatar's lower-right edge. Sits overlapping the card's green header
 * band, so the brand colour comes from the solid band, not the avatar.
 */
function HostAvatar({ size = 72 }: { size?: number }) {
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="h-full w-full overflow-hidden rounded-full border-4 border-card bg-muted">
        <img
          src={HOST.photo}
          alt="Especialista da deco"
          className="h-full w-full object-cover"
          loading="lazy"
        />
      </div>
      {/* availability dot — hugs the avatar edge, DS success colour */}
      <span className="absolute bottom-1.5 right-1.5 flex h-3.5 w-3.5">
        <span
          className="absolute inline-flex h-full w-full rounded-full bg-success opacity-60 motion-safe:animate-ping"
          aria-hidden
        />
        <span className="relative inline-flex h-3.5 w-3.5 rounded-full border-2 border-card bg-success" />
      </span>
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
          {/* Face overlaps the band */}
          <div className="-mt-9 mb-4">
            <HostAvatar />
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
        "flex items-center gap-4 rounded-2xl border border-border bg-card p-5 card-shadow transition-colors hover:bg-accent",
        className,
      )}
    >
      <span className="relative shrink-0">
        <span
          className="block h-11 w-11 overflow-hidden rounded-full"
          style={{ boxShadow: `0 0 0 2px ${GREEN_DARK}` }}
        >
          <img
            src={HOST.photo}
            alt="Especialista da deco"
            className="h-full w-full object-cover"
            loading="lazy"
          />
        </span>
        <span
          className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-card bg-success"
          aria-hidden
        />
      </span>
      {/* Mobile-only banner: headline over two lines, no description (the
          desktop ScheduleMeetingVisual keeps the description). */}
      <span className="flex-1 text-base font-medium leading-5 text-foreground">
        Precisa de ajuda?
        <br />
        Fale conosco
      </span>
      <ArrowUpRight size={18} className="shrink-0 text-muted-foreground" />
    </a>
  );
}
