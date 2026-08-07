import { cn } from "@deco/ui/lib/utils.ts";
import { useRef, useState } from "react";
import type { CoverProps } from "@decocms/shared/reports/deck-types";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { useT } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import Icon from "../icon";
import DeviceCluster from "./device-cluster";
import { DECK, TONE_COLOR } from "./tokens";

// Health bands: red ≤40, yellow 41–60, green ≥61. The gauge draws them, so the
// number is read as a position on a scale rather than a bare figure.
const BAND_BAD_MAX = 40;
const BAND_WARN_MAX = 60;

function scoreTone(n: number) {
  return n > BAND_WARN_MAX
    ? TONE_COLOR.good
    : n > BAND_BAD_MAX
      ? DECK.warn
      : TONE_COLOR.bad;
}

// Macro-theme key → our label. Two generations of keys are mapped on purpose.
//
// `commerce-skills` #255 ("reorganize report score areas into 5 business
// macrotemas") replaced a 9-area grouping (seo / geo / performance / …) with
// the six business macrotemas below. The deployed engine still serves the OLD
// keys, and cached reports carry them too, so both are localized — otherwise a
// reader gets the engine's `label`, which is baked in Portuguese at generation
// time whatever `lang` asked for. Delete the legacy half once #255 is rolled
// out everywhere and old reports have aged out.
//
// The labels are deliberately short: these sit in a two-column grid beside a
// ring and a coverage count, so "Conversion funnel & experience" would truncate.
export const AREA_LABEL: Record<string, TranslationKey> = {
  // macrotemas (commerce-skills #255 onward)
  funil: "reports.coverTemplate.area.funil",
  tecnica: "reports.coverTemplate.area.tecnica",
  tagging: "reports.coverTemplate.area.tagging",
  aquisicao: "reports.coverTemplate.area.aquisicao",
  retencao: "reports.coverTemplate.area.retencao",
  catalogo: "reports.coverTemplate.area.catalogo",
  // legacy areas (pre-#255 engines and cached reports)
  seo: "reports.coverTemplate.area.seo",
  geo: "reports.coverTemplate.area.geo",
  performance: "reports.coverTemplate.area.performance",
  accessibility: "reports.coverTemplate.area.accessibility",
  security: "reports.coverTemplate.area.security",
  ux: "reports.coverTemplate.area.ux",
  tracking: "reports.coverTemplate.area.tracking",
  infra: "reports.coverTemplate.area.infra",
  retention: "reports.coverTemplate.area.retention",
};
/** Count a number up to `target` once the slide becomes active. Returns a
 *  callback ref to hang on the element that owns the animation — it re-attaches
 *  (and so re-plays) whenever `active`/`target` change. */
function useCountUp(target: number, active: boolean) {
  const [value, setValue] = useState(0);
  const ref = (el: HTMLElement | null) => {
    if (!el || !active) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }
    let raf = 0;
    let start = 0;
    const tick = (t: number) => {
      if (!start) start = t;
      const p = Math.min(1, (t - start) / 1100);
      setValue(target * (1 - (1 - p) ** 3));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  };
  return [value, ref] as const;
}

/**
 * The score ring, ported from the private report's rail
 * (`commerce-skills web/tools/report-shell.tsx`): a full-circle track with a
 * border-weight arc, used big for the headline score and small on each area
 * row. Geometry is in viewBox units and the svg fills its box, so the caller
 * sizes it in CSS and the stroke stays proportional.
 */
function Ring({
  score,
  size,
  stroke,
  active,
  className,
  children,
}: {
  score: number;
  /** viewBox units — the geometry, not the rendered box. */
  size: number;
  stroke: number;
  /** Gates the sweep — the arc draws in when the slide arrives. */
  active: boolean;
  /** Box-size utilities. Omitted ⇒ the box is exactly `size` px. */
  className?: string;
  children: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, score));
  return (
    <div
      className={cn("relative shrink-0", className)}
      style={className ? undefined : { width: size, height: size }}
      aria-hidden
    >
      <svg viewBox={`0 0 ${size} ${size}`} className="size-full -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={DECK.border}
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={scoreTone(score)}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (active ? 1 - pct / 100 : 1)}
          className="transition-[stroke-dashoffset] duration-1000 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        {children}
      </div>
    </div>
  );
}

/**
 * The Deco Score in the hero ring, the same object the per-area rows use at a
 * quarter the size — one visual system for "how healthy is this", from the
 * whole store down to a single theme. The arc sweeps while the number counts
 * up.
 *
 * No grade pill beside it: "Crítico" against a red 22/100 inside a red ring was
 * the third rendering of one fact.
 */
function ScoreGauge({
  score,
  active,
}: {
  score: NonNullable<CoverProps["score"]>;
  active: boolean;
}) {
  const t = useT();
  const [animated, ref] = useCountUp(score.value, active);
  const tone = scoreTone(score.value);
  const [tipOpen, setTipOpen] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);

  // Close the tooltip on outside press (touch). The listeners live exactly as
  // long as the tooltip panel is mounted.
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

  return (
    <div ref={ref} className="flex items-center gap-5 lg:gap-6">
      <Ring
        score={score.value}
        size={124}
        stroke={10}
        active={active}
        className="deco-cover-ring"
      >
        <span
          className="deco-cover-number font-light leading-[0.9] tracking-[-0.04em] tabular-nums"
          style={{ color: tone }}
        >
          {Math.round(animated)}
        </span>
        <span
          className="text-[12px] leading-none tabular-nums"
          style={{ color: DECK.faint }}
        >
          {t("reports.coverTemplate.outOf100")}
        </span>
      </Ring>
      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={tipRef} className="relative flex items-center gap-1.5">
          <span
            className="truncate text-[13px] font-medium lg:text-[14px]"
            style={{ color: DECK.muted }}
          >
            {t("reports.coverTemplate.decoScore")}
          </span>
          <button
            type="button"
            aria-label={t("reports.coverTemplate.whatIsDecoScore")}
            className="flex shrink-0 items-center justify-center rounded-full transition-opacity"
            style={{ opacity: tipOpen ? 0.85 : 0.4 }}
            onMouseEnter={() => setTipOpen(true)}
            onMouseLeave={() => setTipOpen(false)}
            onClick={() => setTipOpen((v) => !v)}
          >
            <Icon name="info" size="small" />
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
              {t("reports.coverTemplate.decoScoreExplanation")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The report's macro themes, one hairline-separated row each: a score donut,
 * the theme's name, and how much of it we could actually see — the private
 * report's `AreaRows`, in two columns because this card is landscape where that
 * rail is a tall column.
 *
 * Sourced from `scores.categories`, NOT `scores.by_domain`. `by_domain` is the
 * granular registry taxonomy (INFRA, SEC, TSEO, ONPG, A11Y…): several of those
 * codes roll UP into one theme, most stores emit ten of them, and the engine is
 * explicit that public surfaces must never print them raw. `categories` is the
 * grouping the private report shows, already named, with a severity-weighted
 * score and its own pass/fail/blocked counts.
 */
function AreaRows({
  areas,
  active,
}: {
  areas: NonNullable<CoverProps["areas"]>;
  active: boolean;
}) {
  const t = useT();
  return (
    <ul className="grid grid-cols-1 gap-x-6 lg:grid-cols-2 lg:gap-x-8">
      {areas.map((area, i) => {
        const labelKey = AREA_LABEL[area.key];
        const decided = area.pass + area.fail;
        const total = decided + area.blocked;
        return (
          <li
            key={area.key}
            className="reveal flex items-center gap-3 border-t py-1 lg:gap-4 lg:py-3"
            data-show={active ? "true" : "false"}
            style={{
              borderColor: DECK.border,
              transitionDelay: active ? `${320 + i * 55}ms` : "0ms",
            }}
          >
            <Ring
              score={area.score}
              size={40}
              stroke={4}
              active={active}
              className="size-10 max-lg:size-7 [@media(max-height:799px)]:size-8"
            >
              <span
                className="text-[11px] font-medium leading-none tabular-nums lg:text-[13px]"
                style={{ color: DECK.muted }}
              >
                {area.score}
              </span>
            </Ring>
            <span
              className="min-w-0 flex-1 truncate text-[14px] leading-5 lg:text-[15px]"
              style={{ color: DECK.ink }}
              title={labelKey ? t(labelKey) : area.label}
            >
              {labelKey ? t(labelKey) : area.label}
            </span>
            {/* How much of the theme reached a verdict. Reads as "we saw 16 of
                24 here", which is what makes a 0 honest rather than damning. */}
            <span
              className="shrink-0 text-[12px] leading-5 tabular-nums"
              style={{ color: DECK.faint }}
              title={t("reports.coverTemplate.areaCoverage", {
                decided,
                total,
              })}
            >
              {decided}/{total}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The right half of the card: the visitor's own homepage, and — below it — the
 * macro-theme breakdown with a single button to keep reading. It used to close
 * with a six-row chapter index instead of the breakdown; that put the areas,
 * the headline and the index all shouting the verdict at once, so the index is
 * gone and the one thing left to do next is a single button.
 */
function ScanChamber({
  domain,
  faviconUrl,
  initial,
  screenshot,
  mobileScreenshot,
  areas,
  active,
  onSeeReport,
}: Pick<
  CoverProps,
  | "domain"
  | "faviconUrl"
  | "initial"
  | "screenshot"
  | "mobileScreenshot"
  | "areas"
> & { active: boolean; onSeeReport?: () => void }) {
  const t = useT();

  return (
    <div className="deco-chamber relative flex min-h-0 shrink-0 flex-col justify-end overflow-hidden rounded-2xl lg:flex-1">
      {/* The visitor's homepage, still. It used to carry a sweeping scan line and
          three finding pins that popped in and floated; the motion pulled the eye
          off the content below it, and the pins restated chapters verbatim two
          inches above text that already named them. A quiet screenshot of their
          own site does the same job. Only shown where there's real room for it
          (see `.deco-chamber-preview`) — on a narrow or short viewport the
          card's height belongs to the breakdown and the button below. */}
      <div className="deco-chamber-preview relative z-10 min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-x-7 top-7">
          <DeviceCluster
            domain={domain}
            faviconUrl={faviconUrl}
            initial={initial}
            desktopShot={screenshot}
            mobileShot={mobileScreenshot}
            hidePhone
          />
        </div>
        {/* Progressive blur, stacked under the opacity fade above: the
            screenshot softens before it dissolves, instead of just fading
            sharp-to-transparent. Three backdrop-filter layers at increasing
            blur/mask stops approximate a continuously-increasing blur, which
            no single CSS filter can express. */}
        <div
          className="deco-chamber-blur pointer-events-none absolute inset-x-0 bottom-0 h-32"
          aria-hidden
        >
          <div />
          <div />
          <div />
        </div>
      </div>

      <div className="relative z-10 flex min-h-0 flex-1 flex-col justify-end gap-4 px-5 pb-4 pt-3 lg:flex-none lg:px-6 lg:pb-6 lg:pt-4">
        {areas && areas.length > 0 && (
          <div className="deco-cover-areas min-h-0 flex-1 overflow-y-auto lg:flex-none lg:overflow-visible">
            <AreaRows areas={areas} active={active} />
          </div>
        )}

        {onSeeReport && (
          <button
            type="button"
            onClick={onSeeReport}
            className="reveal flex h-11 shrink-0 items-center justify-center gap-2 rounded-full text-[14px] font-medium transition-colors hover:bg-black/[0.03] lg:h-12"
            data-show={active ? "true" : "false"}
            style={{
              border: `1px solid ${DECK.inputBorder}`,
              color: DECK.ink,
              background: DECK.surface,
              transitionDelay: active ? "420ms" : "0ms",
            }}
          >
            {t("reports.coverTemplate.seeFullReport")}
            <Icon name="arrow_forward" size="small" />
          </button>
        )}
      </div>
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
  brand,
  initial,
  active = false,
  findings,
  areas,
  scannedAt,
  onFindingClick,
}: CoverProps) {
  const t = useT();
  const [{ language }] = usePreferences();
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
  const MAX_TILT = 10; // degrees at the card edge

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

  const nextSlideKey = findings?.[0]?.slideKey;
  const tone = score ? scoreTone(score.value) : DECK.ink;
  const scannedLabel = scannedAt
    ? new Date(scannedAt).toLocaleDateString(language, {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : null;

  return (
    <div
      className="holo-stage flex h-full w-full items-center justify-center px-3 py-2 sm:px-6"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <div
        key={playKey}
        data-enter={active && playKey > 0 ? "true" : "false"}
        className="holo-card h-full w-full max-w-[1120px]"
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
            {/* Card-wide again: with the index panel on paper rather than
                forest there is one surface, so one foil and one glare serve the
                whole card. They were scoped to the left page only for as long as
                the right half was dark. */}
            <div
              className="holo-foil pointer-events-none absolute inset-0 z-30"
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

            {/* ── content (8px inset from the frame; the chamber hugs it) ── */}
            <div className="relative z-10 flex min-h-0 flex-1 flex-col gap-2 p-2 lg:flex-row">
              {/* left: the verdict, as an editorial page */}
              <div className="flex min-h-0 flex-1 flex-col px-4 pb-3 pt-4 lg:w-[55%] lg:flex-initial lg:px-7 lg:py-7">
                {/* Identity — sized like the private report's rail header
                    (`RailHeader`), where the brand carries the block and the
                    favicon is a real tile rather than a bullet. */}
                <div className="flex shrink-0 items-center gap-3.5 lg:gap-4">
                  <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white lg:h-[52px] lg:w-[52px]"
                    style={{
                      border: `1px solid ${DECK.border}`,
                      boxShadow:
                        "0 0.714px 0.714px rgba(0,0,0,0.04),0 4.286px 17.143px rgba(0,0,0,0.01),0 6.429px 34.286px rgba(0,0,0,0.09)",
                    }}
                  >
                    <img
                      src={faviconUrl}
                      alt=""
                      className="h-full w-full object-contain p-2"
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className="truncate text-[19px] font-medium leading-tight lg:text-[23px]"
                      style={{ color: DECK.ink }}
                    >
                      {brand}
                    </span>
                    {/* Wraps on a phone rather than truncating: losing the
                        year off the scan date ("Jul 10, 20…") costs more than
                        a second line. */}
                    <span
                      className="text-[13px] leading-snug lg:truncate lg:text-[15px]"
                      style={{ color: DECK.faint }}
                    >
                      {domain}
                      {" · "}
                      {t("reports.coverTemplate.report")}
                      {scannedLabel ? ` · ${scannedLabel}` : ""}
                    </span>
                  </div>
                </div>

                {/* Two flexible spacers centre the story between the identity
                    and the foot of the page. NOT `flex-1 + justify-center` on
                    the story itself: centred content that outgrows its box
                    overflows in BOTH directions, and on a short viewport that
                    put the headline on top of the domain line. A spacer with a
                    floor can only ever give back the slack it has. */}
                <div className="hidden lg:block lg:min-h-2 lg:flex-1" />

                <div className="mt-4 flex min-h-0 flex-1 flex-col lg:mt-0 lg:block lg:flex-none">
                  {score && (
                    <div
                      className="reveal shrink-0"
                      data-show={active ? "true" : "false"}
                      style={{ transitionDelay: active ? "120ms" : "0ms" }}
                    >
                      <ScoreGauge score={score} active={active} />
                    </div>
                  )}

                  <h1
                    className="deco-cover-verdict reveal mt-5 shrink-0 text-balance font-normal leading-[1.04] tracking-[-0.035em] text-[min(1.5rem,3.6svh)] sm:text-[1.9rem] lg:mt-7 lg:text-[min(clamp(1.6rem,2.15vw,2.25rem),4.2svh)]"
                    data-show={active ? "true" : "false"}
                    style={{
                      color: DECK.ink,
                      transitionDelay: active ? "200ms" : "0ms",
                    }}
                  >
                    {headline}
                  </h1>
                </div>

                <div className="hidden lg:block lg:min-h-2 lg:flex-1" />
              </div>

              {/* right: the scan chamber + macro-theme breakdown */}
              <ScanChamber
                domain={domain}
                faviconUrl={faviconUrl}
                initial={initial}
                screenshot={screenshot}
                mobileScreenshot={mobileScreenshot}
                areas={areas}
                active={active}
                onSeeReport={
                  nextSlideKey && onFindingClick
                    ? () => onFindingClick(nextSlideKey)
                    : undefined
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
