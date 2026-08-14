import { useState } from "react";
import type { CtaProps } from "@decocms/shared/reports/deck-types";
import Icon from "../icon";
import { trackConnectCta } from "../onboarding";
import { useReportCtaHref } from "../use-report-cta-href";
import { useT } from "@/i18n/use-t";
import type { TranslationKey } from "@/i18n/use-t";
import { DECK } from "./tokens";

// ── closing pitch (Figma: Product 2, node 9317-17836) ────────────────────────
// Centered hero over a dark-green card: a count pill, the payoff headline, sub,
// and CTA; a marquee of every audited dimension (each its own icon); and a
// report card peeking from the bottom with the scored areas.

const CARD = DECK.forest;
const LIME = DECK.lime;

// The audited dimensions — each with its own icon and accent (the marquee).
type Pill = { labelKey: TranslationKey; icon: string; color: string };
const PILLS: Pill[] = [
  {
    labelKey: "reports.ctaTemplate.pill.seo",
    icon: "search",
    color: "#ffc116",
  },
  {
    labelKey: "reports.ctaTemplate.pill.aiSearch",
    icon: "smart_toy",
    color: "#14b8a6",
  },
  {
    labelKey: "reports.ctaTemplate.pill.performance",
    icon: "bolt",
    color: "#a595ff",
  },
  {
    labelKey: "reports.ctaTemplate.pill.conversion",
    icon: "shopping_cart",
    color: "#ffc116",
  },
  {
    labelKey: "reports.ctaTemplate.pill.tracking",
    icon: "monitoring",
    color: "#6e9fdb",
  },
  {
    labelKey: "reports.ctaTemplate.pill.accessibility",
    icon: "accessibility_new",
    color: "#b7a8ff",
  },
  {
    labelKey: "reports.ctaTemplate.pill.security",
    icon: "shield",
    color: "#f0846b",
  },
  {
    labelKey: "reports.ctaTemplate.pill.content",
    icon: "article",
    color: "#ffc116",
  },
  {
    labelKey: "reports.ctaTemplate.pill.analytics",
    icon: "bar_chart",
    color: "#a3c73a",
  },
];

// The scored areas shown inside the report card — the report's 5 business
// macrotemas (see .claude/DECISION-TREE.md in commerce-skills; the cover's
// area breakdown renders these from live data). Colors + order mirror the
// MCP-app area palette so the illustrative card matches the real report.
type ReportArea = { labelKey: TranslationKey; score: number; color: string };
const REPORT_AREAS: ReportArea[] = [
  { labelKey: "reports.ctaTemplate.area.funnel", score: 42, color: "#f0b613" },
  {
    labelKey: "reports.ctaTemplate.area.technical",
    score: 46,
    color: "#5fb0a0",
  },
  {
    labelKey: "reports.ctaTemplate.area.dataTagging",
    score: 60,
    color: "#a595ff",
  },
  {
    labelKey: "reports.ctaTemplate.area.acquisition",
    score: 67,
    color: "#6e9fdb",
  },
  {
    labelKey: "reports.ctaTemplate.area.retention",
    score: 75,
    color: "#e07a5f",
  },
];

const SEGMENTS = 14;

// Fixes queued from the findings — the falling backlog on the left.
type FixTask = { title: string; level: string; color: string };
type SampleFixTask = {
  titleKey: TranslationKey;
  levelKey: TranslationKey;
  color: string;
};
/** Severity → the badge shown on a real (engine-supplied) backlog row. */
const SEVERITY_LEVEL: Record<
  "error" | "warning" | "notice",
  { labelKey: TranslationKey; color: string }
> = {
  error: { labelKey: "reports.ctaTemplate.level.high", color: "#d43d3d" },
  warning: { labelKey: "reports.ctaTemplate.level.medium", color: "#f0b613" },
  notice: { labelKey: "reports.ctaTemplate.level.low", color: "#8a8580" },
};
const SAMPLE_FIX_TASKS: SampleFixTask[] = [
  {
    titleKey: "reports.ctaTemplate.fixTask.lcpHome",
    levelKey: "reports.ctaTemplate.level.high",
    color: "#d43d3d",
  },
  {
    titleKey: "reports.ctaTemplate.fixTask.canonical",
    levelKey: "reports.ctaTemplate.level.high",
    color: "#d43d3d",
  },
  {
    titleKey: "reports.ctaTemplate.fixTask.gptBot",
    levelKey: "reports.ctaTemplate.level.medium",
    color: "#f0b613",
  },
  {
    titleKey: "reports.ctaTemplate.fixTask.ga4",
    levelKey: "reports.ctaTemplate.level.high",
    color: "#d43d3d",
  },
  {
    titleKey: "reports.ctaTemplate.fixTask.altImages",
    levelKey: "reports.ctaTemplate.level.medium",
    color: "#f0b613",
  },
  {
    titleKey: "reports.ctaTemplate.fixTask.checkout",
    levelKey: "reports.ctaTemplate.level.high",
    color: "#d43d3d",
  },
  {
    titleKey: "reports.ctaTemplate.fixTask.hstsCsp",
    levelKey: "reports.ctaTemplate.level.medium",
    color: "#f0b613",
  },
];

// Delivery cadence heatmap (7 rows × 16 weeks), deterministic so it's stable.
const HEAT_ROWS = 7;
const HEAT_COLS = 16;
const HEAT_PALETTE = ["#8caa2510", "#cfe8b8", "#9fd07f", "#5fa843", "#0c5122"];
function heatLevel(row: number, col: number): number {
  return (row * 3 + col * 5 + ((row * col) % 4)) % 5;
}

type CadenceMetric = { labelKey: TranslationKey; valueKey: TranslationKey };
const CADENCE_METRICS: CadenceMetric[] = [
  {
    labelKey: "reports.ctaTemplate.cadence.avgFixTime",
    valueKey: "reports.ctaTemplate.cadence.avgFixTimeValue",
  },
  {
    labelKey: "reports.ctaTemplate.cadence.fixesThisWeek",
    valueKey: "reports.ctaTemplate.cadence.fixesThisWeekValue",
  },
  {
    labelKey: "reports.ctaTemplate.cadence.inReview",
    valueKey: "reports.ctaTemplate.cadence.inReviewValue",
  },
];

// ── marquee pill ──────────────────────────────────────────────────────────────

function DimensionPill({ labelKey, icon, color }: Pill) {
  const t = useT();
  return (
    <span
      className="flex shrink-0 items-center gap-2.5 rounded-full py-2 pl-3 pr-5"
      style={{ border: "1px solid rgba(255,255,255,0.25)" }}
    >
      <span style={{ color }}>
        <Icon name={icon} size="xl" />
      </span>
      <span
        className="whitespace-nowrap text-[15px]"
        style={{ color: "#ffffff" }}
      >
        {t(labelKey)}
      </span>
    </span>
  );
}

// ── report card (peeks from the bottom) ───────────────────────────────────────

function SegmentBar({ score, color }: { score: number; color: string }) {
  const filled = Math.round((score / 100) * SEGMENTS);
  return (
    <span className="flex flex-1 items-center gap-[3px]">
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          className="h-2.5 flex-1 rounded-[3px]"
          style={{ background: i < filled ? color : "rgba(40,37,36,0.08)" }}
        />
      ))}
    </span>
  );
}

function ReportCard({
  domain,
  faviconUrl,
  initial,
}: {
  domain: string;
  faviconUrl: string;
  initial: string;
}) {
  const t = useT();
  const [faviconFailed, setFaviconFailed] = useState(false);
  return (
    <div
      className="w-[min(92vw,600px)] rounded-t-2xl bg-white p-6 sm:p-7"
      style={{ boxShadow: "0 -20px 60px rgba(3,32,14,0.35)" }}
    >
      {/* header */}
      <div className="flex items-center gap-2.5">
        <span
          className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md"
          style={{ border: `1px solid ${DECK.border}` }}
        >
          {faviconFailed ? (
            <span
              className="text-[11px] font-semibold"
              style={{ color: DECK.forest }}
            >
              {initial}
            </span>
          ) : (
            <img
              src={faviconUrl}
              alt=""
              className="size-4 object-contain"
              onError={() => setFaviconFailed(true)}
            />
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[15px] font-medium"
          style={{ color: DECK.ink }}
        >
          {domain}
        </span>
        <span
          className="text-[12px] font-semibold uppercase tracking-wide"
          style={{ color: DECK.soft }}
        >
          {t("reports.ctaTemplate.reportCard.diagnostic")}
        </span>
      </div>

      {/* scored areas */}
      <ul className="mt-5 flex flex-col gap-4">
        {REPORT_AREAS.map((area) => (
          <li key={area.labelKey} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: DECK.ink }}
              >
                {t(area.labelKey)}
              </span>
              <span
                className="text-[15px] font-semibold tabular-nums"
                style={{ color: DECK.ink }}
              >
                {area.score}
                <span
                  className="text-[11px] font-normal"
                  style={{ color: DECK.faint }}
                >
                  /100
                </span>
              </span>
            </div>
            <SegmentBar score={area.score} color={area.color} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── falling task backlog (left, decorative) ──────────────────────────────────

function TaskCard({ title, level, color }: FixTask) {
  return (
    <div
      className="rounded-xl bg-white p-3"
      style={{
        border: `1px solid ${DECK.border}`,
        boxShadow: "0 6px 20px rgba(3,32,14,0.12)",
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 size-3.5 shrink-0 rounded-full"
          style={{ border: `1.5px solid ${DECK.faint}` }}
        />
        <span
          className="text-[12.5px] font-medium leading-snug"
          style={{ color: DECK.ink }}
        >
          {title}
        </span>
      </div>
      <span
        className="mt-2 ml-5 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px]"
        style={{ background: "rgba(40,37,36,0.04)", color: DECK.muted }}
      >
        <span className="size-1.5 rounded-full" style={{ background: color }} />
        {level}
      </span>
    </div>
  );
}

function TaskStream({ tasks }: { tasks: FixTask[] }) {
  return (
    <div
      className="h-[400px] w-[248px] overflow-hidden"
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent)",
      }}
    >
      <div className="report-task-track gap-3">
        {[...tasks, ...tasks].map((task, i) => (
          <TaskCard key={`${task.title}-${i}`} {...task} />
        ))}
      </div>
    </div>
  );
}

// ── delivery cadence card (right, decorative) ─────────────────────────────────

function CadenceCard() {
  const t = useT();
  return (
    <div
      className="w-[320px] rounded-2xl bg-white p-5"
      style={{ boxShadow: "0 20px 50px rgba(3,32,14,0.22)" }}
    >
      <span
        className="text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: DECK.soft }}
      >
        {t("reports.ctaTemplate.cadence.title")}
      </span>
      <div
        className="mt-4 grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${HEAT_COLS}, 1fr)` }}
      >
        {Array.from({ length: HEAT_ROWS * HEAT_COLS }, (_, i) => {
          const row = Math.floor(i / HEAT_COLS);
          const col = i % HEAT_COLS;
          return (
            <span
              key={i}
              className="aspect-square rounded-[3px]"
              style={{ background: HEAT_PALETTE[heatLevel(row, col)] }}
            />
          );
        })}
      </div>
      <ul className="mt-4 flex flex-col">
        {CADENCE_METRICS.map((m) => (
          <li
            key={m.labelKey}
            className="flex items-center justify-between py-2.5 text-[13px]"
            style={{ borderTop: `1px solid ${DECK.border}` }}
          >
            <span style={{ color: DECK.muted }}>{t(m.labelKey)}</span>
            <span className="font-semibold" style={{ color: DECK.ink }}>
              {t(m.valueKey)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── slide ─────────────────────────────────────────────────────────────────────

/**
 * Closing CTA slide (always last). Centered hero on a dark-green card, a marquee
 * of the audited dimensions, and a report card peeking from the bottom with the
 * scored areas. The primary action lives in the slide on desktop; on mobile the
 * deck footer carries it too.
 */
export default function CtaTemplate({
  domain,
  faviconUrl,
  initial,
  checksProbed,
  checksTotal,
  remainingItems,
  active = false,
}: CtaProps) {
  const t = useT();
  const show = active ? "true" : "false";
  const ctaHref = useReportCtaHref(domain);
  const hasCoverage =
    typeof checksProbed === "number" && typeof checksTotal === "number";
  // The real backlog when the deck carried round-up signals; the illustrative
  // sample otherwise, so the composition never renders empty.
  const tasks: FixTask[] = remainingItems?.length
    ? remainingItems.map((item) => {
        const level = SEVERITY_LEVEL[item.severity] ?? SEVERITY_LEVEL.notice;
        return {
          title: item.label,
          level: t(level.labelKey),
          color: level.color,
        };
      })
    : SAMPLE_FIX_TASKS.map((task) => ({
        title: t(task.titleKey),
        level: t(task.levelKey),
        color: task.color,
      }));
  return (
    <div className="h-full w-full sm:px-6 lg:px-10 sm:pb-2">
      <div
        className="relative flex h-full w-full flex-col items-center gap-8 overflow-hidden rounded-none px-6 pb-0 pt-8 sm:rounded-3xl sm:px-8 sm:pt-10 lg:gap-10 lg:pt-14 [@media(max-height:780px)]:lg:gap-6 [@media(max-height:780px)]:lg:pt-10"
        style={{ background: CARD }}
      >
        {/* soft glow behind the composition */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[52%] size-[900px] -translate-x-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(208,236,26,0.08), transparent 62%)",
          }}
        />

        {/* hero */}
        <div className="relative z-10 flex max-w-[820px] flex-col items-center gap-5 text-center">
          {hasCoverage ? (
            <span
              className="reveal rounded-full px-4 py-1.5 text-[15px]"
              data-show={show}
              style={{ border: "1px solid rgba(255,255,255,0.25)" }}
            >
              <span style={{ color: "#ffffff" }}>
                {t("reports.ctaTemplate.coverage", {
                  probed: checksProbed,
                  total: checksTotal,
                })}
              </span>
            </span>
          ) : null}

          <h2
            className="reveal text-balance font-normal leading-[1.15] tracking-[-0.015em] text-[clamp(1.5rem,6vw,2.75rem)]"
            data-show={show}
            style={{
              color: "#ffffff",
              transitionDelay: active ? "60ms" : "0ms",
            }}
          >
            {t("reports.ctaTemplate.headline.part1")}
            <br className="hidden sm:block" />{" "}
            {t("reports.ctaTemplate.headline.part2")}
          </h2>

          <p
            className="reveal max-w-[520px] text-[15px] leading-relaxed sm:text-base"
            data-show={show}
            style={{
              color: "rgba(255,255,255,0.75)",
              transitionDelay: active ? "130ms" : "0ms",
            }}
          >
            {t("reports.ctaTemplate.subheading.part1")}
            <br className="hidden sm:block" />{" "}
            {t("reports.ctaTemplate.subheading.part2")}
          </p>

          <a
            href={ctaHref}
            onClick={(e) =>
              trackConnectCta(e, {
                domain,
                placement: "cta_slide",
                slideKey: "cta",
              })
            }
            className="reveal mt-1 inline-flex h-12 items-center gap-2 whitespace-nowrap rounded-full px-8 text-base font-medium transition-transform duration-300 ease-out hover:scale-105"
            data-show={show}
            style={{
              background: LIME,
              color: DECK.forest,
              transitionDelay: active ? "220ms" : "0ms",
            }}
          >
            <span>{t("reports.ctaTemplate.cta.label")}</span>
            <Icon name="arrow_forward" size="medium" />
          </a>
        </div>

        {/* dimension marquee — bleeds past the card edges, fades at the sides */}
        <div
          className="reveal relative z-10 w-[calc(100%+4rem)] shrink-0 overflow-hidden sm:w-[calc(100%+8rem)]"
          data-show={show}
          style={{
            transitionDelay: active ? "300ms" : "0ms",
            maskImage:
              "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)",
            WebkitMaskImage:
              "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)",
          }}
        >
          <div className="report-marquee-track gap-2">
            {[...PILLS, ...PILLS].map((p, i) => (
              <DimensionPill key={`${p.labelKey}-${i}`} {...p} />
            ))}
          </div>
        </div>

        {/* bottom stage: report card center, backlog left, cadence right.
            All top-aligned so tops stay visible and bottoms peek off-slide;
            side cards tuck behind the report card via negative margins. */}
        <div className="relative z-10 flex w-full flex-1 items-start justify-center overflow-hidden">
          {/* left: falling backlog of fixes (behind, decorative) */}
          <div
            className="reveal pointer-events-none relative z-0 -mr-24 mt-3 hidden shrink-0 -rotate-[5deg] xl:block"
            data-show={show}
            style={{ transitionDelay: active ? "460ms" : "0ms" }}
          >
            <TaskStream tasks={tasks} />
          </div>

          {/* center: the diagnostic report card */}
          <div
            className="reveal relative z-20 shrink-0"
            data-show={show}
            style={{ transitionDelay: active ? "380ms" : "0ms" }}
          >
            <ReportCard
              domain={domain}
              faviconUrl={faviconUrl}
              initial={initial}
            />
          </div>

          {/* right: delivery cadence card (behind, tilted) */}
          <div
            className="reveal pointer-events-none relative z-0 -ml-24 mt-3 hidden shrink-0 rotate-[6deg] xl:block"
            data-show={show}
            style={{ transitionDelay: active ? "440ms" : "0ms" }}
          >
            <CadenceCard />
          </div>
        </div>
      </div>
    </div>
  );
}
