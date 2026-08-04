import { cn } from "@deco/ui/lib/utils.ts";
import posthog from "posthog-js";
import { useEffectEvent, useRef, useState } from "react";
import type {
  DeckSlide,
  TemplateDeck,
} from "@decocms/shared/reports/deck-types";
import { isPostHogInitialized } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";
import { VALID_LOCALES } from "@/i18n/locale.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { authClient } from "@/lib/auth-client";
import { resolveEmailLinkToken } from "./api";
import { ReportAuthOverlay } from "./auth-gate";
import Icon from "./icon";
import { onboardingUrl, trackConnectCta } from "./onboarding";
import { resolveLogoUrl } from "./source-logos";
import SlideTemplate from "./templates/registry";
import { DECK } from "./templates/tokens";
import { captureReport } from "./track";

const pad = (n: number) => String(n).padStart(2, "0");

const sharerPersonId = () =>
  isPostHogInitialized() ? posthog.get_distinct_id() : undefined;

// Pure deck renderer — the deck is built server-side (format_for_view) and
// supplied by the route; see `@decocms/shared/reports/to-deck` + ScanGate for the data flow.
export default function SignalDeck({
  deck,
  sessionUser,
  authenticated = true,
}: {
  deck: TemplateDeck;
  sessionUser?: { name?: string; email?: string; image?: string };
  /** Unauthenticated visitors see the cover slide only — advancing past it
   *  prompts login instead of navigating (see `go` below). */
  authenticated?: boolean;
}) {
  const t = useT();
  const [authGateOpen, setAuthGateOpen] = useState(false);
  const [{ language }, setPreferences] = usePreferences();
  const total = deck.slides.length;
  const [index, setIndex] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [methoOpen, setMethoOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSent, setFeedbackSent] = useState(false);
  const [feedbackSubmitting, setFeedbackSubmitting] = useState(false);
  const feedbackTypedRef = useRef(false);
  const deckCompletedRef = useRef(false);
  // Mobile-only: flash the progress rail briefly on slide change.
  const [navVisible, setNavVisible] = useState(false);
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [shareAnchorRect, setShareAnchorRect] = useState<DOMRect | null>(null);
  const [sharePlacement, setSharePlacement] = useState<"above" | "below">(
    "above",
  );
  // Minted once per popover opening, so the twitter/linkedin hrefs and their
  // click events agree on one share_id (see handleShareClick).
  const [popoverShareId, setPopoverShareId] = useState("");

  const ctaHref = onboardingUrl(`https://${deck.meta.domain}/`);
  const slide = deck.slides[index];
  // Template-based, not `index === total - 1`: a truncated (anonymous) deck
  // has only the cover slide, which then sits at `total - 1` too.
  const isCtaSlide = slide?.template.template === "cta";
  const lockRef = useRef(false);
  const sharePopoverRef = useRef<HTMLDivElement>(null);

  /** Per-slide side effects that used to live in an index-keyed effect: close
   *  the popovers, emit slide_viewed, and mark completion on the last slide.
   *  Called from every navigation path (mount, go(), popstate). */
  const announceSlide = (i: number) => {
    const s = deck.slides[i];
    if (!s) return;
    setMethoOpen(false);
    setFeedbackOpen(false);
    setFeedbackText("");
    setFeedbackSent(false);
    setFeedbackSubmitting(false);
    feedbackTypedRef.current = false;
    captureReport("report_slide_viewed", {
      domain: deck.meta.domain,
      slide_key: s.key,
      slide_index: i,
      // Deck length varies per store — without the total, position 7 can't be
      // told apart from "the deck ended at 7". Enables progress-% analysis.
      slides: total,
      slide_title: s.title,
      template: s.template.template,
      surface: "deck_v2",
    });
    // Once per mount — revisiting the last slide is not a second completion.
    // Unauthenticated visitors only ever see the cover, so "reaching slide 0"
    // there isn't a real completion.
    if (authenticated && i === total - 1 && !deckCompletedRef.current) {
      deckCompletedRef.current = true;
      captureReport("report_deck_completed", {
        domain: deck.meta.domain,
        slides: total,
        surface: "deck_v2",
      });
    }
  };

  /** Flash the progress rail on mobile (navigation only, not initial render). */
  const flashNav = () => {
    setNavVisible(true);
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    navTimerRef.current = setTimeout(() => setNavVisible(false), 400);
  };

  // Effect Events let the long-lived keyboard/wheel/touch listeners read the
  // latest slide index without render-time ref mutation or listener churn.
  const go = useEffectEvent((i: number) => {
    // Every navigation path (keyboard, wheel/swipe, rail, footer, in-slide
    // links) funnels through here, so gating it is enough to gate the deck.
    if (!authenticated && i > 0) {
      setAuthGateOpen(true);
      return;
    }
    const clamped = Math.min(Math.max(i, 0), total - 1);
    if (clamped === index) return;
    history.pushState({ slideIndex: clamped }, "");
    setShareOpen(false);
    setIndex(clamped);
    announceSlide(clamped);
    flashNav();
  });

  // Advance one slide per gesture, then lock briefly so momentum scroll or a
  // long swipe doesn't fly through several slides at once.
  const step = useEffectEvent((dir: number) => {
    if (lockRef.current || dir === 0) return;
    lockRef.current = true;
    go(index + dir);
    setTimeout(() => {
      lockRef.current = false;
    }, 650);
  });

  // ── mount wiring (callback refs with cleanup — no useEffect) ──────────────

  /** Once per deck mount: funnel analytics + share/email-link attribution +
   *  history seeding + keyboard nav + the initial slide_viewed. */
  const deckMountRef = (el: HTMLDivElement | null) => {
    if (!el) return;

    captureReport("report_viewed", {
      domain: deck.meta.domain,
      slides: total,
      surface: "deck_v2",
    });

    // Share-graph recipient side: if this view arrived via a shared link
    // (?share_id=…), stamp it once on the person so who-opened-whose-share is
    // joinable. No recipient-side share event — the sharer already emitted one.
    const params = new URLSearchParams(window.location.search);
    const inboundShareId = params.get("share_id");
    if (inboundShareId && isPostHogInitialized()) {
      posthog.setPersonProperties(undefined, {
        inbound_share_id: inboundShareId,
      });
    }

    // Cross-device email open: `d` is an unguessable id the engine minted —
    // resolveEmailLinkToken looks it up server-side to the {domain, run_id} it
    // was minted for, letting this open be attributed to the right store
    // across devices. Best-effort, fire-and-forget.
    const emailToken = params.get("d");
    if (emailToken && params.get("utm_source") === "email") {
      const emailRunId = params.get("email_run_id");
      captureReport("report_email_link_opened", {
        domain: deck.meta.domain,
        surface: "deck_v2",
        ...(emailRunId ? { email_run_id: emailRunId } : {}),
      });
      resolveEmailLinkToken(emailToken)
        .then((resolved) => {
          if (!isPostHogInitialized()) return;
          posthog.setPersonProperties(undefined, {
            ...(emailRunId ? { inbound_email_run_id: emailRunId } : {}),
            ...(resolved ? { inbound_email_domain: resolved.domain } : {}),
          });
        })
        .catch(() => {
          if (emailRunId && isPostHogInitialized()) {
            posthog.setPersonProperties(undefined, {
              inbound_email_run_id: emailRunId,
            });
          }
        });
    }

    announceSlide(0);

    // Seed the history stack so the browser back gesture steps through slides
    // rather than navigating away from the page entirely.
    history.replaceState({ slideIndex: 0 }, "");
    const onPopState = (e: PopStateEvent) => {
      const i = e.state?.slideIndex ?? 0;
      setShareOpen(false);
      setIndex(i);
      announceSlide(i);
      flashNav();
    };
    window.addEventListener("popstate", onPopState);

    const onKey = (e: KeyboardEvent) => {
      if (["ArrowDown", "ArrowRight", "PageDown", " "].includes(e.key)) {
        e.preventDefault();
        go(index + 1);
      } else if (["ArrowUp", "ArrowLeft", "PageUp"].includes(e.key)) {
        e.preventDefault();
        go(index - 1);
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("keydown", onKey);
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    };
  };

  /** Wheel / trackpad + touch-swipe navigation (one slide per gesture),
   *  attached to the deck root for its whole lifetime. */
  const gesturesRef = (root: HTMLDivElement | null) => {
    if (!root) return;

    // A slide can contain its own vertical scroll region (the findings TOC, the
    // minor-signals list). Walk from the gesture target up to the deck root; if
    // an ancestor can still scroll in the gesture's direction, let it scroll
    // natively instead of advancing the deck.
    const absorbsScroll = (target: EventTarget | null, down: boolean) => {
      let el = target as HTMLElement | null;
      while (el && el !== root) {
        if (el.scrollHeight > el.clientHeight + 1) {
          const oy = getComputedStyle(el).overflowY;
          if (oy === "auto" || oy === "scroll") {
            const atTop = el.scrollTop <= 0;
            const atBottom =
              el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
            if (down ? !atBottom : !atTop) return true;
          }
        }
        el = el.parentElement;
      }
      return false;
    };

    // Same idea sideways (the mobile products carousel). Checked without an
    // edge test: a horizontal gesture that starts inside a carousel belongs to
    // it for the whole gesture — otherwise a swipe that lands on the last card
    // would also flip the slide.
    const inHorizontalScroller = (target: EventTarget | null) => {
      let el = target as HTMLElement | null;
      while (el && el !== root) {
        if (el.scrollWidth > el.clientWidth + 1) {
          const ox = getComputedStyle(el).overflowX;
          if (ox === "auto" || ox === "scroll") return true;
        }
        el = el.parentElement;
      }
      return false;
    };

    const onWheel = (e: WheelEvent) => {
      const vertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
      if (vertical && absorbsScroll(e.target, e.deltaY > 0)) return;
      if (!vertical && inHorizontalScroller(e.target)) return;
      const delta = vertical ? e.deltaY : e.deltaX;
      if (Math.abs(delta) < 12) return;
      e.preventDefault();
      step(delta > 0 ? 1 : -1);
    };

    let startX = 0;
    let startY = 0;
    let startTarget: EventTarget | null = null;
    const onTouchStart = (e: TouchEvent) => {
      startX = e.touches[0]?.clientX ?? 0;
      startY = e.touches[0]?.clientY ?? 0;
      startTarget = e.target;
    };
    // The deck is a fixed overlay, so the document always sits at scrollTop 0 —
    // without this, a downward swipe (previous slide) triggers the browser's
    // native pull-to-refresh and reloads the page. Block the default scroll
    // gesture unless the touch belongs to an inner scrollable region or a
    // pinch-zoom (2+ fingers). Chart canvases are NOT exempt: preventDefault
    // only suppresses native page scroll (ECharts' own touch handlers still
    // run), and a canvas often covers the whole slide.
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length > 1) return;
      const dx = startX - (e.touches[0]?.clientX ?? 0);
      const dy = startY - (e.touches[0]?.clientY ?? 0);
      if (Math.abs(dx) > Math.abs(dy) && inHorizontalScroller(startTarget))
        return;
      if (absorbsScroll(startTarget, dy > 0)) return;
      if (e.cancelable) e.preventDefault();
    };
    const onTouchEnd = (e: TouchEvent) => {
      const dx = startX - (e.changedTouches[0]?.clientX ?? 0);
      const dy = startY - (e.changedTouches[0]?.clientY ?? 0);
      const d = Math.abs(dy) >= Math.abs(dx) ? dy : dx;
      if (Math.abs(d) <= 50) return;
      // Touch that started on a chart canvas: horizontal-ish gestures belong to
      // the chart (ECharts tooltip panning), but a decisively vertical swipe is
      // slide navigation — a canvas often covers the whole slide, and swallowing
      // vertical swipes there strands the user on the slide.
      if (
        (startTarget as Element | null)?.closest?.("canvas") &&
        Math.abs(dy) < Math.abs(dx) * 1.5
      )
        return;
      // vertical swipe over a scrollable region → it scrolled; don't also step.
      if (Math.abs(dy) >= Math.abs(dx) && absorbsScroll(startTarget, dy > 0))
        return;
      // horizontal swipe inside a carousel → it scrolled; don't also step.
      if (Math.abs(dx) > Math.abs(dy) && inHorizontalScroller(startTarget))
        return;
      step(d > 0 ? 1 : -1);
    };

    root.addEventListener("wheel", onWheel, { passive: false });
    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd, { passive: true });

    // Belt-and-suspenders for browsers that honor it declaratively
    // (Chrome/Android, Safari 16+): disable pull-to-refresh at the viewport.
    const html = document.documentElement;
    const prevHtmlOverscroll = html.style.overscrollBehaviorY;
    const prevBodyOverscroll = document.body.style.overscrollBehaviorY;
    html.style.overscrollBehaviorY = "none";
    document.body.style.overscrollBehaviorY = "none";

    return () => {
      root.removeEventListener("wheel", onWheel);
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      html.style.overscrollBehaviorY = prevHtmlOverscroll;
      document.body.style.overscrollBehaviorY = prevBodyOverscroll;
    };
  };

  const userInitials = sessionUser?.name
    ? sessionUser.name
        .split(" ")
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase()
    : (sessionUser?.email?.[0]?.toUpperCase() ?? "U");

  /** Close the user menu on outside pointerdown. */
  const userMenuOutsideRef = (panel: HTMLDivElement | null) => {
    userMenuRef.current = panel;
    if (!panel) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(e.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  };

  /** Close the share popover on outside pointerdown — listeners live exactly
   *  as long as the popover is mounted. */
  const shareOutsideRef = (panel: HTMLDivElement | null) => {
    sharePopoverRef.current = panel;
    if (!panel) return;
    const onPointerDown = (e: PointerEvent) => {
      if (
        sharePopoverRef.current &&
        !sharePopoverRef.current.contains(e.target as Node)
      ) {
        setShareOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  };

  // A share act mints one share_id (`<domain>:<slide_key>:<rand>`). The same id
  // is stamped on both the URL (recipient reads it back → inbound_share_id) and
  // the report_slide_shared event, so the share graph joins who-shared-what
  // to who-opened-it. utm_source=share lets us split share traffic in analytics.
  const newShareId = (s: DeckSlide) =>
    `${deck.meta.domain}:${s.key}:${Math.random().toString(36).slice(2, 10)}`;

  const buildShareUrl = (s: DeckSlide, shareId: string) => {
    const origin = window.location.origin;
    const q = new URLSearchParams({
      share_id: shareId,
      utm_source: "share",
      utm_medium: "deck",
      utm_campaign: "report",
    });
    return `${origin}/report/${encodeURIComponent(deck.meta.domain)}?${q.toString()}#${s.key}`;
  };

  const buildShareText = (s: DeckSlide) =>
    `🔍 ${deck.meta.brand}\n\n"${s.headline.replace(/\n/g, " ")}"\n\n${t("reports.signalDeck.shareText")}`;

  const handleShareClick = async (e: React.MouseEvent, s: DeckSlide) => {
    const isTouchDevice = window.matchMedia("(pointer: coarse)").matches;
    if (isTouchDevice && typeof navigator !== "undefined" && navigator.share) {
      try {
        const shareId = newShareId(s);
        const shareUrl = buildShareUrl(s, shareId);
        await navigator.share({
          title: `${deck.meta.brand} — ${s.title}`,
          text: buildShareText(s),
          url: shareUrl,
        });
        captureReport("report_slide_shared", {
          domain: deck.meta.domain,
          slide_key: s.key,
          slide_index: index,
          surface: "deck_v2",
          method: "web_share",
          share_id: shareId,
          sharer_person_id: sharerPersonId(),
        });
      } catch {
        /* dismissed */
      }
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setShareAnchorRect(rect);
    // Header actions have room below; footer actions have room above. Keeping
    // this geometry-based means every share button gets the natural direction
    // without coupling the handler to a specific chrome location.
    setSharePlacement(rect.top < window.innerHeight / 2 ? "below" : "above");
    // Mint the popover's share_id at open time so its hrefs + events agree.
    setPopoverShareId(newShareId(s));
    setShareOpen((o) => !o);
  };

  const copyShareLink = async (s: DeckSlide) => {
    const shareId = newShareId(s);
    const shareUrl = buildShareUrl(s, shareId);
    try {
      await navigator.clipboard?.writeText(shareUrl);
      setToast(t("reports.signalDeck.linkCopied"));
      captureReport("report_slide_shared", {
        domain: deck.meta.domain,
        slide_key: s.key,
        slide_index: index,
        surface: "deck_v2",
        method: "copy_link",
        share_id: shareId,
        sharer_person_id: sharerPersonId(),
      });
    } catch {
      setToast(t("reports.signalDeck.copyError"));
    }
    setShareOpen(false);
    setTimeout(() => setToast(null), 1800);
  };

  if (!slide) return null;

  const ease = "cubic-bezier(0.16,1,0.3,1)";

  return (
    <div
      ref={(el) => {
        const cleanupMount = deckMountRef(el);
        const cleanupGestures = gesturesRef(el);
        return () => {
          cleanupMount?.();
          cleanupGestures?.();
        };
      }}
      className="fixed inset-0 flex flex-col font-sans antialiased"
      // Grayscale smoothing renders Switzer light and crisp; without it macOS
      // falls back to heavier subpixel AA. Also drop inherited stylistic-set
      // features — inert on Switzer, but cleaner to null them on the deck root.
      style={{
        background: DECK.bg,
        color: DECK.ink,
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        fontFeatureSettings: "normal",
      }}
    >
      {/* ───────── header — rounded translucent bar, deco logo, and the Share
          pill. Sits in the flow as the deck's top row. ───────── */}
      <header className="shrink-0 px-3 pt-3 sm:px-6 sm:pt-4">
        <div
          className="mx-auto flex h-14 max-w-[1360px] items-center gap-3 rounded-full border pl-4 pr-3 backdrop-blur-md sm:h-[60px] sm:pl-6 sm:pr-4"
          style={{
            borderColor: DECK.cardBorder,
            background: "rgba(255,255,255,0.82)",
            boxShadow:
              "0 1px 2px rgba(40,37,36,0.05), 0 10px 30px -20px rgba(40,37,36,0.35)",
          }}
        >
          <a
            href="https://decocms.com"
            aria-label={t("reports.signalDeck.decoHome")}
            className="flex shrink-0 items-center opacity-95 transition-opacity hover:opacity-70"
          >
            <img
              src="/logos/deco-logo.svg"
              alt="deco"
              width={54}
              height={22}
              className="h-[22px] w-auto"
            />
          </a>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Language toggle — writes the same `language` preference the rest
                of Studio reads, and the route re-fetches the deck with `lang`,
                so both the chrome AND the generated deck copy switch. */}
            <div
              className="flex h-9 shrink-0 items-center rounded-full border p-0.5"
              role="group"
              aria-label={t("reports.signalDeck.languageLabel")}
              style={{
                borderColor: DECK.cardBorder,
                background: DECK.surface,
              }}
            >
              {VALID_LOCALES.map((locale) => {
                const on = language === locale;
                return (
                  <button
                    key={locale}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setPreferences((prev) => ({ ...prev, language: locale }))
                    }
                    className="h-8 rounded-full px-3 text-xs font-medium uppercase transition-colors"
                    style={{
                      background: on ? DECK.primary : "transparent",
                      color: on ? DECK.primaryFg : DECK.muted,
                    }}
                  >
                    {/* Locale codes are the label — never translated. */}
                    {locale === "pt-BR" ? "PT" : "EN"}
                  </button>
                );
              })}
            </div>
            {sessionUser && (
              <div className="relative" ref={userMenuOutsideRef}>
                <button
                  type="button"
                  aria-label={t("reports.signalDeck.userMenuLabel")}
                  aria-expanded={userMenuOpen}
                  onClick={() => setUserMenuOpen((o) => !o)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border text-sm font-medium transition-transform hover:scale-[1.03]"
                  style={{
                    borderColor: DECK.cardBorder,
                    background: sessionUser.image
                      ? "transparent"
                      : DECK.surface,
                    color: DECK.ink,
                  }}
                >
                  {sessionUser.image ? (
                    <img
                      src={sessionUser.image}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-[11px]">{userInitials}</span>
                  )}
                </button>
                {userMenuOpen && (
                  <div
                    className="absolute right-0 top-full z-50 mt-2 min-w-[180px] overflow-hidden rounded-xl border shadow-xl"
                    style={{
                      background: DECK.surface,
                      borderColor: DECK.border,
                    }}
                  >
                    {sessionUser.email && (
                      <div
                        className="border-b px-4 py-3"
                        style={{ borderColor: DECK.border }}
                      >
                        <p
                          className="truncate text-xs"
                          style={{ color: DECK.muted }}
                        >
                          {sessionUser.email}
                        </p>
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setUserMenuOpen(false);
                        authClient.signOut();
                      }}
                      className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium transition-colors hover:bg-black/5"
                      style={{ color: DECK.ink }}
                    >
                      <Icon name="logout" size="medium" />
                      {t("reports.signalDeck.signOut")}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={(e) => handleShareClick(e, slide)}
              className="inline-flex h-9 items-center rounded-full px-5 text-sm font-medium transition-transform hover:scale-[1.03]"
              style={{ background: DECK.primary, color: DECK.primaryFg }}
            >
              {t("reports.signalDeck.share")}
            </button>
          </div>
        </div>
      </header>

      {/* ───────── stage ───────── */}
      <main className="relative min-h-0 flex-1 overflow-hidden">
        {/* vertical track — slides scroll into place as `index` changes */}
        <div
          className="h-full w-full"
          style={{
            transform: `translateY(-${index * 100}%)`,
            transition: `transform 620ms ${ease}`,
          }}
        >
          {deck.slides.map((s, i) => (
            <div key={s.key} className="h-full w-full overflow-hidden">
              {/* The CTA slide is a full-bleed card on mobile (its own dark
                  background reaches every edge), so it drops the vertical gutter
                  there. The cover is a self-contained card that wants to sit
                  close to the chrome on mobile, so it takes a tighter gutter.
                  Every other slide keeps the default. Desktop always gets py-8. */}
              <div
                className={cn(
                  "mx-auto flex h-full w-full max-w-[1440px] flex-col sm:py-8",
                  s.template.template === "cta"
                    ? "py-0"
                    : s.template.template === "cover"
                      ? "py-3"
                      : "py-6",
                )}
              >
                <SlideTemplate
                  slide={s}
                  deck={deck}
                  active={i === index}
                  onNavigate={(key) =>
                    go(deck.slides.findIndex((sl) => sl.key === key))
                  }
                />
              </div>
            </div>
          ))}
        </div>

        {/* side progress rail — always rendered; desktop: always visible; mobile: flashes in on slide change then fades out */}
        <nav
          className="absolute right-3 top-1/2 flex -translate-y-1/2 flex-col gap-1.5 transition-opacity duration-300 md:!opacity-100"
          style={{ opacity: navVisible ? 1 : 0 }}
          aria-label={t("reports.signalDeck.slidesNav")}
        >
          {deck.slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-label={t("reports.signalDeck.goToSlide", { title: s.title })}
              onClick={() => go(i)}
              className="group relative flex h-5 items-center justify-end"
            >
              <span
                className="pointer-events-none absolute right-9 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium opacity-0 transition-all duration-200 group-hover:opacity-100"
                style={{ background: DECK.ink, color: DECK.bg }}
              >
                {s.title}
              </span>
              <span
                className="rounded-full transition-all duration-300"
                style={{
                  height: i === index ? 3 : 2,
                  width: i === index ? 28 : 12,
                  background: i === index ? DECK.ink : "rgba(40,37,36,0.22)",
                }}
              />
            </button>
          ))}
        </nav>
      </main>

      {/* ───────── footer ───────── */}
      {/* On the CTA slide (last), the footer is dark-green on mobile so it reads
          as a seamless extension of the full-bleed card. Desktop is always light. */}
      <footer
        className="flex shrink-0 items-center gap-2 px-4 py-4 sm:px-6"
        style={
          isCtaSlide
            ? {
                borderTop: "1px solid rgba(255,255,255,0.14)",
                background: DECK.forest,
              }
            : { borderTop: `1px solid ${DECK.border}` }
        }
      >
        {/* On the last slide (the CTA): MOBILE shows Share + a full-width action
            (Figma). DESKTOP shows only a slide counter + Share — the primary CTA
            lives inside the slide there, so the footer stays light. */}
        {isCtaSlide ? (
          <>
            {/* desktop: counter (left) */}
            <span
              className="hidden text-sm tabular-nums opacity-50 lg:block"
              style={{ color: DECK.ink }}
            >
              {pad(index + 1)}/{pad(total)}
            </span>
            {/* mobile: share icon — white-on-dark on the CTA slide */}
            <button
              type="button"
              onClick={(e) => handleShareClick(e, slide)}
              aria-label={t("reports.signalDeck.shareButton")}
              className="grid h-12 w-12 shrink-0 place-items-center rounded-full border lg:hidden"
              style={{
                borderColor: "rgba(255,255,255,0.2)",
                color: "#ffffff",
                background: "rgba(255,255,255,0.08)",
              }}
            >
              <Icon name="share" size="large" />
            </button>
            {/* mobile: full-width CTA — lime on the CTA slide */}
            <a
              href={ctaHref}
              onClick={(e) =>
                trackConnectCta(e, {
                  domain: deck.meta.domain,
                  placement: "deck_footer_mobile",
                  slideKey: slide.key,
                  slideIndex: index,
                })
              }
              className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full px-6 text-base font-medium transition-transform duration-300 ease-out hover:scale-105 lg:hidden"
              style={{ background: DECK.lime, color: DECK.forest }}
            >
              <span>{t("reports.signalDeck.viewFullDiagnostic")}</span>
              <Icon name="arrow_forward" size="large" />
            </a>
            {/* desktop: Share on the right (CTA is in-slide) */}
            <button
              type="button"
              onClick={(e) => handleShareClick(e, slide)}
              className="ml-auto hidden h-12 items-center gap-2 rounded-full border px-6 text-sm font-medium lg:inline-flex"
              style={{
                borderColor: DECK.inputBorder,
                color: DECK.ink,
                background: DECK.surface,
              }}
            >
              <Icon name="share" size="medium" />
              <span>{t("reports.signalDeck.shareButton")}</span>
            </button>
          </>
        ) : (
          <>
            {/* left: attribution bar — data sources · Como medimos · A IA errou? */}
            <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
              {/* per-slide data sources (what produced this finding) */}
              {slide.sources?.length ? (
                <div className="hidden items-center gap-1.5 sm:flex">
                  {slide.sources.map((s) => (
                    <span
                      key={s.name}
                      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs"
                      style={{
                        borderColor: DECK.border,
                        color: DECK.ink,
                        background: DECK.surface,
                      }}
                    >
                      {resolveLogoUrl(s.name, s.logoUrl) && (
                        <img
                          src={resolveLogoUrl(s.name, s.logoUrl)}
                          alt=""
                          width={14}
                          height={14}
                          className="rounded-sm"
                          onError={(e) => {
                            (
                              e.currentTarget as HTMLImageElement
                            ).style.display = "none";
                          }}
                        />
                      )}
                      <span className="whitespace-nowrap">{s.name}</span>
                    </span>
                  ))}
                </div>
              ) : null}

              {/* Como medimos — methodology popover (icon-only on mobile; the
                  footer only has room for one text label, "A IA errou?") */}
              {slide.methodology ? (
                <span className="group relative">
                  <button
                    type="button"
                    aria-label={t("reports.signalDeck.methodology")}
                    aria-expanded={methoOpen}
                    onClick={() => {
                      setFeedbackOpen(false);
                      setMethoOpen((o) => !o);
                    }}
                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-2 text-[13px] transition-colors hover:bg-black/5 sm:text-sm"
                    style={{ color: methoOpen ? DECK.ink : DECK.muted }}
                  >
                    <Icon name="info" size="medium" />
                    <span className="hidden whitespace-nowrap underline decoration-1 underline-offset-2 opacity-90 sm:inline">
                      {t("reports.signalDeck.methodology")}
                    </span>
                  </button>
                  <span
                    className={cn(
                      "absolute bottom-full left-0 mb-3 w-72 max-w-[calc(100vw-2rem)] rounded-xl p-4 text-sm leading-relaxed shadow-sm transition-opacity duration-200 group-hover:opacity-100",
                      methoOpen
                        ? "opacity-100"
                        : "pointer-events-none opacity-0",
                    )}
                    style={{
                      background: DECK.surface,
                      border: `1px solid ${DECK.border}`,
                      color: DECK.muted,
                    }}
                  >
                    {slide.methodology}
                  </span>
                </span>
              ) : null}

              {/* A IA errou? — report an incorrect reading for this slide */}
              <span className="group relative">
                <button
                  type="button"
                  aria-label={t("reports.signalDeck.reportError")}
                  aria-expanded={feedbackOpen}
                  onClick={() => {
                    setMethoOpen(false);
                    setFeedbackOpen((o) => {
                      const next = !o;
                      if (next)
                        captureReport("report_ai_feedback_opened", {
                          domain: deck.meta.domain,
                          slide_key: slide.key,
                          slide_index: index,
                          surface: "deck_v2",
                        });
                      return next;
                    });
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-2 text-[13px] transition-colors hover:bg-black/5 sm:text-sm"
                  style={{ color: feedbackOpen ? DECK.ink : DECK.muted }}
                >
                  <Icon name="flag" size="medium" />
                  <span className="whitespace-nowrap underline decoration-1 underline-offset-2 opacity-90">
                    {t("reports.signalDeck.reportError")}
                  </span>
                </button>
                <div
                  className={cn(
                    "absolute bottom-full left-0 mb-3 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-xl p-4 text-sm leading-relaxed shadow-sm transition-opacity duration-200",
                    feedbackOpen
                      ? "opacity-100 pointer-events-auto"
                      : "pointer-events-none opacity-0",
                  )}
                  style={{
                    background: DECK.surface,
                    border: `1px solid ${DECK.border}`,
                    color: DECK.muted,
                  }}
                >
                  {feedbackSent ? (
                    <p style={{ color: DECK.ink }}>
                      {t("reports.signalDeck.feedbackThanks")}
                    </p>
                  ) : (
                    <>
                      <p>{t("reports.signalDeck.feedbackQuestion")}</p>
                      <textarea
                        rows={3}
                        value={feedbackText}
                        onChange={(e) => {
                          setFeedbackText(e.target.value);
                          if (
                            !feedbackTypedRef.current &&
                            e.target.value.length > 0
                          ) {
                            feedbackTypedRef.current = true;
                            captureReport("report_ai_feedback_started", {
                              domain: deck.meta.domain,
                              slide_key: slide.key,
                              slide_index: index,
                              surface: "deck_v2",
                            });
                          }
                        }}
                        placeholder={t(
                          "reports.signalDeck.feedbackPlaceholder",
                        )}
                        className="w-full resize-none rounded-xl border px-3 py-2 text-sm leading-relaxed outline-none focus:ring-1 focus:ring-[#282524]"
                        style={{
                          borderColor: DECK.border,
                          background: DECK.bg,
                          color: DECK.ink,
                        }}
                      />
                      <button
                        type="button"
                        disabled={!feedbackText.trim() || feedbackSubmitting}
                        onClick={() => {
                          setFeedbackSubmitting(true);
                          captureReport("report_ai_feedback_reported", {
                            domain: deck.meta.domain,
                            slide_key: slide.key,
                            slide_index: index,
                            slide_title: slide.title,
                            surface: "deck_v2",
                            feedback_text: feedbackText.trim(),
                          });
                          setFeedbackSent(true);
                          setFeedbackSubmitting(false);
                        }}
                        className="inline-flex items-center gap-1.5 self-start rounded-full px-4 py-2 text-sm font-medium transition-opacity disabled:opacity-40"
                        style={{
                          background: DECK.primary,
                          color: DECK.primaryFg,
                        }}
                      >
                        <Icon name="flag" size="small" />
                        <span>
                          {feedbackSubmitting
                            ? t("reports.signalDeck.sending")
                            : t("reports.signalDeck.reportError")}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              </span>

              <span
                className="ml-1 hidden text-sm tabular-nums opacity-50 sm:inline"
                style={{ color: DECK.ink }}
              >
                {pad(index + 1)}/{pad(total)}
              </span>
            </div>

            {/* right: scores badge + Share + Next */}
            <div className="ml-auto flex items-center gap-2">
              {deck.meta.scores ? (
                <span
                  className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs tabular-nums lg:inline-flex"
                  style={{
                    background: DECK.surface,
                    border: `1px solid ${DECK.border}`,
                    color: DECK.muted,
                  }}
                  title={t("reports.signalDeck.coverageTooltip", {
                    probed: deck.meta.scores.coverage.checks_probed,
                    total: deck.meta.scores.coverage.checks_total,
                  })}
                >
                  <span style={{ color: DECK.ink }}>
                    {deck.meta.scores.cover}/100
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {t("reports.signalDeck.measured", {
                      probed: deck.meta.scores.coverage.checks_probed,
                      total: deck.meta.scores.coverage.checks_total,
                    })}
                  </span>
                </span>
              ) : null}
              <button
                type="button"
                onClick={(e) => handleShareClick(e, slide)}
                className="inline-flex h-12 w-12 items-center justify-center gap-2 rounded-full border font-medium sm:w-auto sm:px-6 sm:text-sm"
                style={{
                  borderColor: DECK.inputBorder,
                  color: DECK.ink,
                  background: DECK.surface,
                }}
              >
                <Icon name="share" size="large" />
                <span className="hidden sm:inline">
                  {t("reports.signalDeck.shareButton")}
                </span>
              </button>
              {/* mobile: up/down icon buttons */}
              <div className="flex items-center gap-1 sm:hidden">
                <button
                  type="button"
                  onClick={() => go(index - 1)}
                  disabled={index === 0}
                  aria-label={t("reports.signalDeck.previousSlide")}
                  className="grid h-12 w-12 place-items-center rounded-full border disabled:opacity-30"
                  style={{
                    borderColor: DECK.inputBorder,
                    color: DECK.ink,
                    background: DECK.surface,
                  }}
                >
                  <Icon name="arrow_upward" size="large" />
                </button>
                <button
                  type="button"
                  onClick={() => go(index + 1)}
                  aria-label={t("reports.signalDeck.nextSlide")}
                  className="grid h-12 w-12 place-items-center rounded-full"
                  style={{ background: DECK.primary, color: DECK.primaryFg }}
                >
                  <Icon name="arrow_downward" size="large" />
                </button>
              </div>
              {/* desktop: text button */}
              <button
                type="button"
                onClick={() => go(index + 1)}
                className="hidden h-12 items-center gap-2 rounded-full px-6 text-sm font-medium sm:inline-flex"
                style={{ background: DECK.primary, color: DECK.primaryFg }}
              >
                <span>{t("reports.signalDeck.next")}</span>
                <Icon name="arrow_forward" size="medium" />
              </button>
            </div>
          </>
        )}
      </footer>

      {shareOpen && shareAnchorRect && (
        <div
          ref={shareOutsideRef}
          role="menu"
          className="fixed z-50 flex min-w-[200px] flex-col overflow-hidden rounded-xl border shadow-xl"
          style={{
            background: DECK.surface,
            borderColor: DECK.border,
            ...(sharePlacement === "below"
              ? { top: shareAnchorRect.bottom + 8 }
              : { bottom: window.innerHeight - shareAnchorRect.top + 8 }),
            left: shareAnchorRect.left + shareAnchorRect.width / 2,
            transform: "translateX(-50%)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => copyShareLink(slide)}
            className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-black/5"
            style={{ color: DECK.ink }}
          >
            <Icon name="link" size="medium" />
            {t("reports.signalDeck.copyLink")}
          </button>
          <a
            role="menuitem"
            href={`https://twitter.com/intent/tweet?url=${encodeURIComponent(buildShareUrl(slide, popoverShareId))}&text=${encodeURIComponent(buildShareText(slide))}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              captureReport("report_slide_shared", {
                domain: deck.meta.domain,
                slide_key: slide.key,
                slide_index: index,
                surface: "deck_v2",
                method: "twitter",
                share_id: popoverShareId,
                sharer_person_id: sharerPersonId(),
              });
              setShareOpen(false);
            }}
            className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-black/5"
            style={{ color: DECK.ink }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.748l7.73-8.835L1.254 2.25H8.08l4.261 5.635zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            {t("reports.signalDeck.shareOnX")}
          </a>
          <a
            role="menuitem"
            href={`https://www.linkedin.com/shareArticle?mini=true&url=${encodeURIComponent(buildShareUrl(slide, popoverShareId))}&title=${encodeURIComponent(`${deck.meta.brand} — ${slide.title}`)}&summary=${encodeURIComponent(buildShareText(slide))}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              captureReport("report_slide_shared", {
                domain: deck.meta.domain,
                slide_key: slide.key,
                slide_index: index,
                surface: "deck_v2",
                method: "linkedin",
                share_id: popoverShareId,
                sharer_person_id: sharerPersonId(),
              });
              setShareOpen(false);
            }}
            className="flex items-center gap-3 px-4 py-3 text-sm font-medium transition-colors hover:bg-black/5"
            style={{ color: DECK.ink }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
            </svg>
            {t("reports.signalDeck.shareOnLinkedIn")}
          </a>
        </div>
      )}

      {toast && (
        <div
          className="fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2 text-sm font-medium shadow-lg"
          style={{ background: DECK.ink, color: DECK.bg }}
        >
          {toast}
        </div>
      )}

      {authGateOpen && (
        <ReportAuthOverlay
          domain={deck.meta.domain}
          onClose={() => setAuthGateOpen(false)}
        />
      )}
    </div>
  );
}
