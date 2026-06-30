/**
 * Variant Calendar — displays every scheduled variant from the decofile on a
 * month grid (Google-Calendar style) or a Gantt-style timeline. The data
 * source is `extractScheduledVariants`, which only emits variants gated by a
 * `website/matchers/date.ts` rule; non-time-scoped variants (audience,
 * device, etc.) intentionally don't appear.
 */
import { useState } from "react";
import {
  Activity,
  Calendar,
  ChevronLeft,
  ChevronRight,
} from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.js";
import { ScrollArea } from "@deco/ui/components/scroll-area.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { ViewModeToggle } from "@deco/ui/components/view-mode-toggle.tsx";
import {
  type BlockColor,
  buildBlockColorMap,
  colorFromMap,
  extractScheduledVariants,
  type ScheduledVariant,
} from "./extract-variants";
import {
  addMonths,
  buildMonthWeeks,
  MONTHS,
  placeWeekSegments,
  startOfDay,
  startOfMonth,
  WEEKDAYS,
} from "./date-utils";

type ViewMode = "calendar" | "timeline";

const RANGE_FORMAT = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

function formatRangeForTooltip(v: ScheduledVariant): string {
  return `${RANGE_FORMAT.format(v.start)} → ${RANGE_FORMAT.format(v.end)}`;
}

/**
 * The Radix tooltip body shown by both calendar and timeline bars. Pulls
 * `blockLabel` / `innerPath` / `label` / formatted range; suppresses
 * duplicate lines when the variant has no nested path or the label
 * coincides with the block name.
 */
function VariantTooltipBody({ variant }: { variant: ScheduledVariant }) {
  return (
    <TooltipContent>
      <div className="text-xs">
        <div className="font-semibold">{variant.blockLabel}</div>
        {variant.innerPath && (
          <div className="text-muted-foreground">{variant.innerPath}</div>
        )}
        {variant.label !== variant.blockLabel &&
          variant.label !== variant.innerPath && (
            <div className="text-muted-foreground">{variant.label}</div>
          )}
        <div className="mt-1">{formatRangeForTooltip(variant)}</div>
      </div>
    </TooltipContent>
  );
}

/**
 * One colored bar with its hover tooltip. The caller owns positioning via
 * `style` (top/left/width/height or %-based equivalents) and what shows
 * inside the bar via `children`.
 */
function VariantBar({
  variant,
  color,
  style,
  children,
}: {
  variant: ScheduledVariant;
  color: BlockColor;
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="absolute flex items-center px-2 text-[11px] font-medium truncate cursor-default"
          style={{
            background: color.bg,
            color: color.text,
            borderRadius: 4,
            ...style,
          }}
        >
          <span className="truncate">{children}</span>
        </div>
      </TooltipTrigger>
      <VariantTooltipBody variant={variant} />
    </Tooltip>
  );
}

export function VariantCalendar({
  decofile,
}: {
  decofile: Record<string, unknown> | null | undefined;
}) {
  const [view, setView] = useState<ViewMode>("calendar");
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));

  const variants = extractScheduledVariants(decofile);
  const colorMap = buildBlockColorMap(variants.map((v) => v.blockKey));

  const goToday = () => setCursor(startOfMonth(new Date()));
  const goPrev = () =>
    setCursor((c) =>
      view === "calendar" ? addMonths(c, -1) : addMonths(c, -3),
    );
  const goNext = () =>
    setCursor((c) => (view === "calendar" ? addMonths(c, 1) : addMonths(c, 3)));

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between px-4 h-12 border-b shrink-0">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={goToday}>
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={goPrev}
            aria-label="Previous"
          >
            <ChevronLeft size={16} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={goNext}
            aria-label="Next"
          >
            <ChevronRight size={16} />
          </Button>
          <h2 className="ml-2 text-base font-semibold">
            {MONTHS[cursor.getMonth()]} {cursor.getFullYear()}
          </h2>
        </div>
        <ViewModeToggle<ViewMode>
          value={view}
          onValueChange={setView}
          options={[
            {
              value: "calendar",
              icon: <Calendar />,
              label: "Calendar",
            },
            {
              value: "timeline",
              icon: <Activity />,
              label: "Timeline",
            },
          ]}
        />
      </div>

      {variants.length === 0 ? (
        <EmptyState />
      ) : view === "calendar" ? (
        <CalendarView
          monthStart={cursor}
          variants={variants}
          colorMap={colorMap}
        />
      ) : (
        <TimelineView
          monthStart={cursor}
          variants={variants}
          colorMap={colorMap}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground p-6">
      <Calendar size={24} className="text-muted-foreground/60" />
      <div>No scheduled variants.</div>
      <div className="text-xs text-muted-foreground/80">
        Variants gated by a date matcher appear here.
      </div>
    </div>
  );
}

const LANE_HEIGHT = 20;
const LANE_GAP = 2;
const HEADER_HEIGHT = 28;

function CalendarView({
  monthStart,
  variants,
  colorMap,
}: {
  monthStart: Date;
  variants: ScheduledVariant[];
  colorMap: Map<string, BlockColor>;
}) {
  const weeks = buildMonthWeeks(monthStart);
  const today = startOfDay(new Date());

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="min-w-[840px]">
        <div className="grid grid-cols-7 border-b text-xs text-muted-foreground sticky top-0 bg-background z-10">
          {WEEKDAYS.map((wd) => (
            <div
              key={wd}
              className="px-2 py-2 text-center uppercase tracking-wide"
            >
              {wd}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => {
          const segments = placeWeekSegments(week, variants);
          const laneCount = segments.reduce(
            (m, s) => Math.max(m, s.lane + 1),
            0,
          );
          const rowHeight =
            HEADER_HEIGHT + laneCount * (LANE_HEIGHT + LANE_GAP) + 8;
          return (
            <div
              key={wi}
              className="grid grid-cols-7 relative border-b"
              style={{ height: rowHeight }}
            >
              {week.map((day, di) => {
                const isCurrentMonth = day.getMonth() === monthStart.getMonth();
                const isToday = day.getTime() === today.getTime();
                return (
                  <div
                    key={di}
                    className={cn(
                      "border-r last:border-r-0 px-2 pt-1.5 text-xs",
                      isCurrentMonth
                        ? "bg-background"
                        : "bg-muted/30 text-muted-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1",
                        isToday &&
                          "bg-primary text-primary-foreground font-semibold",
                      )}
                    >
                      {day.getDate()}
                    </span>
                  </div>
                );
              })}
              {segments.map((seg, idx) => {
                const color = colorFromMap(colorMap, seg.variant.blockKey);
                const top = HEADER_HEIGHT + seg.lane * (LANE_HEIGHT + LANE_GAP);
                const leftPct = (seg.startCol / 7) * 100;
                const widthPct = (seg.span / 7) * 100;
                return (
                  <VariantBar
                    key={`${wi}-${idx}`}
                    variant={seg.variant}
                    color={color}
                    style={{
                      top,
                      left: `calc(${leftPct}% + 2px)`,
                      width: `calc(${widthPct}% - 4px)`,
                      height: LANE_HEIGHT,
                    }}
                  >
                    {seg.variant.blockLabel}
                    {seg.variant.label !== seg.variant.blockLabel && (
                      <span className="opacity-70">
                        {" · "}
                        {seg.variant.label}
                      </span>
                    )}
                  </VariantBar>
                );
              })}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

const TIMELINE_MONTHS = 4;
const ROW_HEIGHT = 32;
const ROW_LABEL_WIDTH = 240;

function TimelineView({
  monthStart,
  variants,
  colorMap,
}: {
  monthStart: Date;
  variants: ScheduledVariant[];
  colorMap: Map<string, BlockColor>;
}) {
  const rangeStart = monthStart;
  const rangeEnd = addMonths(monthStart, TIMELINE_MONTHS);
  const today = new Date();

  // Group variants by block for the row layout.
  const byBlock = new Map<string, ScheduledVariant[]>();
  for (const v of variants) {
    const arr = byBlock.get(v.blockKey) ?? [];
    arr.push(v);
    byBlock.set(v.blockKey, arr);
  }
  const sortedBlocks = Array.from(byBlock.entries()).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  const totalMs = rangeEnd.getTime() - rangeStart.getTime();
  const pctOf = (d: Date) => {
    const clamped = Math.max(
      rangeStart.getTime(),
      Math.min(rangeEnd.getTime(), d.getTime()),
    );
    return ((clamped - rangeStart.getTime()) / totalMs) * 100;
  };

  const monthHeaders = Array.from({ length: TIMELINE_MONTHS }, (_, i) =>
    addMonths(rangeStart, i),
  );

  const todayPct =
    today.getTime() >= rangeStart.getTime() &&
    today.getTime() <= rangeEnd.getTime()
      ? pctOf(today)
      : null;

  return (
    <ScrollArea className="flex-1 min-h-0">
      <div className="min-w-[900px] relative">
        <div className="flex border-b sticky top-0 bg-background z-10">
          <div
            className="shrink-0 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground border-r"
            style={{ width: ROW_LABEL_WIDTH }}
          >
            Variant / Block
          </div>
          <div
            className="flex-1 grid"
            style={{
              gridTemplateColumns: `repeat(${TIMELINE_MONTHS}, minmax(0, 1fr))`,
            }}
          >
            {monthHeaders.map((m, i) => (
              <div
                key={i}
                className="px-2 py-2 text-xs uppercase tracking-wide text-muted-foreground border-r last:border-r-0"
              >
                {MONTHS[m.getMonth()]?.slice(0, 3)} {m.getFullYear()}
              </div>
            ))}
          </div>
        </div>
        {todayPct !== null && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 w-px bg-primary/70 z-[5]"
            style={{
              left: `calc(${ROW_LABEL_WIDTH}px + (100% - ${ROW_LABEL_WIDTH}px) * ${todayPct} / 100)`,
            }}
          >
            <span className="absolute -top-0.5 -translate-x-1/2 rounded-sm bg-primary px-1.5 py-px text-[10px] font-medium text-primary-foreground">
              Today
            </span>
          </div>
        )}
        {sortedBlocks.map(([blockKey, blockVariants]) => {
          const color = colorFromMap(colorMap, blockKey);
          const blockLabel = blockVariants[0]?.blockLabel ?? blockKey;
          return (
            <div key={blockKey}>
              <div
                className="flex items-center bg-muted/40 border-b text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                style={{ height: 28 }}
              >
                <div
                  className="px-3 truncate"
                  style={{ width: ROW_LABEL_WIDTH }}
                >
                  {blockLabel}
                </div>
              </div>
              {blockVariants.map((v, i) => (
                <div
                  key={i}
                  className="flex border-b items-center"
                  style={{ height: ROW_HEIGHT }}
                >
                  <div
                    className="flex items-center gap-2 px-3 text-sm border-r shrink-0"
                    style={{ width: ROW_LABEL_WIDTH }}
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-full shrink-0"
                      style={{ background: color.bg }}
                    />
                    <span className="truncate text-foreground/80">
                      {v.label}
                    </span>
                  </div>
                  <div className="relative flex-1 h-full">
                    {/* month gridlines */}
                    <div
                      className="absolute inset-0 grid"
                      style={{
                        gridTemplateColumns: `repeat(${TIMELINE_MONTHS}, minmax(0, 1fr))`,
                      }}
                    >
                      {monthHeaders.map((_, mi) => (
                        <div
                          key={mi}
                          className="border-r last:border-r-0 border-border/40"
                        />
                      ))}
                    </div>
                    {(() => {
                      const segStart = Math.max(
                        v.start.getTime(),
                        rangeStart.getTime(),
                      );
                      const segEnd = Math.min(
                        v.end.getTime(),
                        rangeEnd.getTime(),
                      );
                      if (segEnd <= segStart) return null;
                      const left = pctOf(new Date(segStart));
                      const width = pctOf(new Date(segEnd)) - left;
                      return (
                        <VariantBar
                          variant={v}
                          color={color}
                          style={{
                            top: "50%",
                            transform: "translateY(-50%)",
                            left: `${left}%`,
                            width: `calc(${width}% - 2px)`,
                            height: 22,
                          }}
                        >
                          {v.label}
                        </VariantBar>
                      );
                    })()}
                  </div>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
