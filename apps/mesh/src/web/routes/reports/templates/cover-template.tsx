import { cn } from "@deco/ui/lib/utils.ts";
import { useRef, useState } from "react";
import type { CoverProps } from "@/reports/deck-types";
import Icon from "../icon";
import DeviceCluster from "./device-cluster";
import { DECK, TONE_COLOR } from "./tokens";
import { useT } from "@/web/i18n/use-t.ts";

// Health bands: red ≤40, yellow 41–60, green ≥61.
function scoreTone(n: number) {
  return n >= 61 ? TONE_COLOR.good : n >= 41 ? DECK.warn : TONE_COLOR.bad;
}

// ponytail: this is a module-scope constant used in a component; resolution moved inside the component
const DECO_SCORE_EXPLANATION_KEY = "reports.coverTemplate.decoScoreExplanation";

/** The Deco Score — ring + oversized count-up number + label. The count-up is
 *  driven by a rAF loop started from a callback ref (re-attached when
 *  `active`/`value` change), writing to state so ring + number stay in sync. */
function ScoreBlock({
  score,
  active,
  compact,
}: {
  score: NonNullable<CoverProps["score"]>;
  active: boolean;
  compact?: boolean;
}) {
  const t = useT();
  const [animated, setAnimated] = useState(0);
  const tone = scoreTone(score.value);
  const ringSize = compact ? 66 : 104;
  const ringW = compact ? 7 : 10;
  const [tipOpen, setTipOpen] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

  // Count-up on activation. Callback refs re-run when their captured values
  // change (React Compiler memoizes on deps), so this re-plays per activation.
  const countUpRef = (el: HTMLDivElement | null) => {
    if (!el || !active) return;
    const target = score.value;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setAnimated(target);
      return;
    }
    const ms = 1100;
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / ms);
      setAnimated(target * (1 - (1 - p) ** 3));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  };

  // Close tooltip on outside click (touch devices). The listeners live exactly
  // as long as the tooltip panel is mounted.
  const outsideCloseRef = (panel: HTMLDivElement | null) => {
    if (!panel) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (tipRef.current && !tipRef.current.contains(e.target as Node)) {
        setTipOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  };

  const pct = Math.min(100, Math.max(0, animated));
  const r = (ringSize - ringW) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <div
      ref={countUpRef}
      className="flex shrink-0 items-center gap-3.5 lg:gap-5"
    >
      {/* Arc ring without text — the animated value drives the fill. */}
      <svg width={ringSize} height={ringSize} className="-rotate-90 shrink-0">
        <circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={r}
          fill="none"
          stroke={DECK.border}
          strokeWidth={ringW}
        />
        <circle
          cx={ringSize / 2}
          cy={ringSize / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={ringW}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span
            className="font-light leading-[0.9] tracking-[-0.02em] tabular-nums text-[2.4rem] lg:text-[4rem]"
            style={{ color: tone }}
          >
            {Math.round(animated)}
          </span>
          <span className="text-sm lg:text-xl" style={{ color: DECK.faint }}>
            / 100
          </span>
        </div>
        <div ref={tipRef} className="relative flex items-center gap-1">
          <span
            className="text-[11px] font-medium uppercase tracking-[0.04em] lg:text-[12px]"
            style={{ color: DECK.soft }}
          >
            {t("reports.coverTemplate.decoScore")}
          </span>
          <button
            type="button"
            aria-label={t("reports.coverTemplate.whatIsDecoScore")}
            className="flex items-center justify-center rounded-full transition-opacity"
            style={{ opacity: tipOpen ? 0.8 : 0.45 }}
            onMouseEnter={() => setTipOpen(true)}
            onMouseLeave={() => setTipOpen(false)}
            onClick={() => setTipOpen((v) => !v)}
          >
            <Icon name="info" size="medium" class="" />
          </button>
          {tipOpen && (
            <div
              ref={outsideCloseRef}
              className="absolute left-0 top-full z-50 mt-2 w-72 rounded-xl px-4 py-3.5 text-sm leading-[1.6] shadow-xl"
              style={{
                background: DECK.surface,
                border: `1px solid ${DECK.border}`,
                color: DECK.ink,
                boxShadow:
                  "0 4px 6px rgba(40,37,36,0.06), 0 12px 32px rgba(40,37,36,0.12)",
              }}
            >
              {t(DECO_SCORE_EXPLANATION_KEY)}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The device preview treated as the card's holographic illustration: a large
 * rounded panel with a pastel-rainbow foil fill (bigger than the previews, so
 * the rainbow reads as the artwork) plus the interactive foil / glare / glitter
 * layers that shift with the tilt.
 */
function ArtPanel({
  deviceCluster,
  className = "",
  innerClassName = "max-w-[520px]",
  padClassName = "p-4 sm:p-6",
  alignClassName = "items-center",
}: {
  deviceCluster: React.ReactNode;
  className?: string;
  innerClassName?: string;
  padClassName?: string;
  alignClassName?: string;
}) {
  return (
    <div className={cn("deco-art relative overflow-hidden", className)}>
      {/* Pastel rainbow base — always-on so the panel is holographic at rest. */}
      <div className="holo-art-base absolute inset-0 z-0" aria-hidden />
      {/* Previews composited on the rainbow. */}
      <div
        className={cn(
          "relative z-10 flex h-full w-full justify-center",
          alignClassName,
          padClassName,
        )}
      >
        <div className={cn("w-full", innerClassName)}>{deviceCluster}</div>
      </div>
      {/* Interactive holo layers. */}
      <div
        className="holo-artfoil pointer-events-none absolute inset-0 z-20"
        aria-hidden
      />
      <div
        className="holo-sparkle pointer-events-none absolute inset-0 z-20"
        aria-hidden
      />
      <div
        className="holo-artglare pointer-events-none absolute inset-0 z-30"
        aria-hidden
      />
    </div>
  );
}

export default function CoverTemplate({
  headline,
  score,
  screenshot,
  mobileScreenshot,
  faviconUrl,
  domain,
  initial,
  active = false,
  findings,
  onFindingClick,
}: CoverProps) {
  const t = useT();
  // Replay the deal-in entrance every time the slide re-enters (keyed remount).
  // Render-phase "state from props" adjustment — no effect needed.
  const [prevActive, setPrevActive] = useState(active);
  // The cover is the initial active slide, so its first mount must count as a
  // play too. Starting at zero leaves `.holo-card` at opacity: 0 until the user
  // navigates away and returns.
  const [playKey, setPlayKey] = useState(active ? 1 : 0);
  if (active !== prevActive) {
    setPrevActive(active);
    if (active) setPlayKey((k) => k + 1);
  }

  // Pointer tilt — poke-holo feel (https://poke-holo.simey.me): the rotation
  // eases toward the pointer instead of snapping, while the holo/glare layers
  // track the pointer directly. Uses exponential smoothing (a critically-damped
  // lerp), NOT a spring — so it glides smoothly with no bounce/overshoot. Runs
  // in a rAF loop writing CSS vars straight to the node (no re-render).
  const tiltRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef(0);
  const springRef = useRef({
    rx: 0,
    ry: 0,
    trx: 0, // target rx
    tryy: 0, // target ry
    hovering: false,
  });

  // Per-frame easing factor (~60fps): fraction of the remaining distance closed
  // each frame. Lower = smoother/floatier, higher = snappier. No velocity term,
  // so it never overshoots — a smooth glide along the axis.
  const EASE = 0.12;
  const MAX_TILT = 14; // degrees at the card edge

  const tick = () => {
    const el = tiltRef.current;
    const s = springRef.current;
    if (!el) {
      rafRef.current = 0;
      return;
    }
    s.rx += (s.trx - s.rx) * EASE;
    s.ry += (s.tryy - s.ry) * EASE;
    el.style.setProperty("--rx", `${s.rx.toFixed(3)}deg`);
    el.style.setProperty("--ry", `${s.ry.toFixed(3)}deg`);
    const settled =
      Math.abs(s.trx - s.rx) < 0.02 && Math.abs(s.tryy - s.ry) < 0.02;
    if (s.hovering || !settled) {
      rafRef.current = requestAnimationFrame(tick);
    } else {
      rafRef.current = 0;
    }
  };
  const ensureLoop = () => {
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tick);
  };

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = tiltRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const s = springRef.current;
    s.hovering = true;
    // spring target — the card "looks at" the pointer
    s.trx = (0.5 - py) * (MAX_TILT * 2);
    s.tryy = (px - 0.5) * (MAX_TILT * 2);
    // holo/glare track the pointer directly (no spring — the shine is snappy)
    el.style.setProperty("--mx", `${(px * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(py * 100).toFixed(1)}%`);
    el.style.setProperty("--posx", `${(20 + px * 60).toFixed(1)}%`);
    el.style.setProperty("--posy", `${(20 + py * 60).toFixed(1)}%`);
    el.style.setProperty("--active", "1");
    ensureLoop();
  };
  const onLeave = () => {
    const el = tiltRef.current;
    if (!el) return;
    const s = springRef.current;
    s.hovering = false;
    s.trx = 0; // spring back to flat
    s.tryy = 0;
    el.style.setProperty("--mx", "50%");
    el.style.setProperty("--my", "50%");
    el.style.setProperty("--posx", "50%");
    el.style.setProperty("--posy", "50%");
    el.style.setProperty("--active", "0");
    ensureLoop();
  };
  // Callback ref: hold the node + cancel any in-flight rAF on unmount.
  const tiltMountRef = (el: HTMLDivElement | null) => {
    tiltRef.current = el;
    return () => cancelAnimationFrame(rafRef.current);
  };

  const tone = score ? scoreTone(score.value) : DECK.ink;

  const header = (
    <div
      className="flex shrink-0 items-center gap-3 pb-3.5 lg:gap-4 lg:pb-4"
      style={{ borderBottom: `1px solid ${DECK.border}` }}
    >
      <div
        className="flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white"
        style={{
          width: 40,
          height: 40,
          border: `1px solid ${DECK.border}`,
          boxShadow:
            "0 0.714px 0.714px rgba(0,0,0,0.04),0 4.286px 17.143px rgba(0,0,0,0.01),0 6.429px 34.286px rgba(0,0,0,0.09)",
        }}
      >
        <img
          src={faviconUrl}
          alt=""
          className="h-full w-full object-contain p-1.5"
        />
      </div>
      <span
        className="min-w-0 flex-1 truncate text-sm lg:text-base"
        style={{ color: DECK.ink }}
      >
        <span style={{ color: DECK.faint }}>https://</span>
        {domain}
      </span>
      <span
        className="shrink-0 text-[10px] font-medium uppercase tracking-[0.04em] lg:text-[11px]"
        style={{ color: DECK.soft }}
      >
        {t("reports.coverTemplate.report")}
      </span>
    </div>
  );

  return (
    <div
      className="holo-stage flex h-full w-full items-center justify-center px-3 py-2 sm:px-6"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <div
        key={playKey}
        data-enter={active && playKey > 0 ? "true" : "false"}
        className="holo-card h-full w-full max-w-[1080px]"
      >
        {/* Holographic metallic frame — a gradient border that shifts on tilt. */}
        <div
          ref={tiltMountRef}
          className="holo-tilt relative flex h-full w-full flex-col rounded-[26px] p-[2px]"
          style={{ "--tone": tone } as React.CSSProperties}
        >
          {/* Inner card surface — everything clips to the rounded corners. */}
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-[24px]"
            style={{
              background:
                "radial-gradient(120% 80% at 30% 0%, #ffffff 0%, #fafaf9 45%, #f6f4f1 100%)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(40,37,36,0.05), 0 1px 2px rgba(40,37,36,0.04)",
            }}
          >
            {/* whole-card holo wash + glare + entrance sweep */}
            <div
              className="holo-foil pointer-events-none absolute inset-0 z-30"
              aria-hidden
            />
            <div
              className="holo-lines pointer-events-none absolute inset-0 z-30"
              aria-hidden
            />
            <div
              className="holo-glare pointer-events-none absolute inset-0 z-40"
              aria-hidden
            />
            <div
              className="deco-sweep pointer-events-none absolute inset-0 z-50 overflow-hidden"
              aria-hidden
            >
              <span className="holo-sweep-bar" />
            </div>

            {/* ── content (8px inset from the frame; art panel hugs that inset) ── */}
            <div className="relative z-10 grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-2">
              {/* left: score + verdict + findings */}
              <div className="flex min-h-0 flex-col px-4 pb-3 pt-4 lg:px-5 lg:py-5">
                {header}

                {score && (
                  <div className="mt-4 shrink-0 lg:mt-4">
                    {/* mobile: compact score */}
                    <div className="lg:hidden">
                      <ScoreBlock score={score} active={active} compact />
                    </div>
                    {/* desktop: hero score */}
                    <div className="hidden lg:block">
                      <ScoreBlock score={score} active={active} />
                    </div>
                  </div>
                )}

                <h1
                  className="reveal mt-3.5 text-balance text-[min(1.375rem,3svh)] font-normal leading-[1.16] tracking-[-0.02em] sm:text-2xl lg:mt-4 lg:text-[1.7rem]"
                  data-show={active ? "true" : "false"}
                  style={{
                    color: DECK.ink,
                    transitionDelay: active ? "140ms" : "0ms",
                  }}
                >
                  {headline}
                </h1>

                {/* Findings — capped to 4 on mobile so the list always stays
                    fully visible; desktop shows all and pins them to the bottom
                    (mt-auto), shrinking + scrolling if a short viewport can't fit
                    them. The pb keeps the fade over padding, not a row. */}
                {findings && findings.length > 0 && (
                  <ul className="holo-findings mt-4 flex min-h-0 shrink-0 flex-col overflow-y-auto pb-2 lg:mt-auto lg:shrink lg:pb-5 lg:pt-4">
                    {findings.map((finding, i) => (
                      <li
                        key={finding.slideKey}
                        className={cn("reveal", i >= 4 && "hidden lg:block")}
                        data-show={active ? "true" : "false"}
                        style={{
                          ...(i < findings.length - 1
                            ? { borderBottom: `1px solid ${DECK.border}` }
                            : {}),
                          transitionDelay: active ? `${240 + i * 55}ms` : "0ms",
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => onFindingClick?.(finding.slideKey)}
                          className="group flex w-full items-center gap-3 py-2 transition-colors hover:bg-black/[0.03] active:bg-black/[0.06] lg:gap-3.5 lg:py-2.5"
                          style={{
                            cursor: onFindingClick ? "pointer" : "default",
                          }}
                        >
                          <span
                            className="shrink-0 text-[11px] tabular-nums lg:text-[12px]"
                            style={{ color: DECK.soft }}
                          >
                            {String(i + 1).padStart(2, "0")}
                          </span>
                          <span
                            className="min-w-0 flex-1 truncate text-left text-[13px] opacity-55 transition-opacity group-hover:opacity-85 lg:text-[15px]"
                            style={{ color: DECK.ink, lineHeight: 1.3 }}
                          >
                            {finding.title}
                          </span>
                          <Icon
                            name="arrow_forward"
                            size="xs"
                            class="shrink-0 opacity-0 transition-opacity group-hover:opacity-40"
                          />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* mobile: the preview — a holographic panel that fills the
                    remaining height below the findings. The browser preview is the
                    same as desktop, scaled to fill the panel width and top-anchored
                    so it bleeds off the bottom edge of the card (cropped by the
                    panel), rather than floating small. Hidden on desktop. */}
                <div
                  className="reveal mt-4 min-h-[150px] flex-1 lg:hidden"
                  data-show={active ? "true" : "false"}
                  style={{ transitionDelay: active ? "260ms" : "0ms" }}
                >
                  <ArtPanel
                    deviceCluster={
                      <DeviceCluster
                        domain={domain}
                        faviconUrl={faviconUrl}
                        initial={initial}
                        desktopShot={screenshot}
                        mobileShot={mobileScreenshot}
                        hidePhone
                      />
                    }
                    className="deco-art-mobile h-full w-full rounded-2xl"
                    innerClassName="max-w-[440px]"
                    padClassName="px-5 pt-6"
                    alignClassName="items-start"
                  />
                </div>
              </div>

              {/* right: the big holographic art panel (desktop) */}
              <div className="hidden lg:block">
                <ArtPanel
                  deviceCluster={
                    <DeviceCluster
                      domain={domain}
                      faviconUrl={faviconUrl}
                      initial={initial}
                      desktopShot={screenshot}
                      mobileShot={mobileScreenshot}
                    />
                  }
                  className="h-full w-full rounded-2xl"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
