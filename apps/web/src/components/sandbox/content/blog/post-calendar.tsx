/**
 * Post Calendar — the blog's scheduling surface. Every post from the decofile
 * sits on a month grid: scheduled posts on their go-live instant, everything
 * else on its editorial `date` so the month reads as a full content plan.
 *
 * Those two are drawn apart on purpose. A post placed by its `date` is NOT
 * scheduled — nothing will publish it — and a calendar that rendered both the
 * same way would read as a promise the system never made.
 *
 * Clicking a post opens it in the editor; dragging a scheduled one onto
 * another day moves its go-live day, keeping its time.
 */
import { useState } from "react";
import {
  AlertCircle,
  CalendarDate,
  ChevronLeft,
  ChevronRight,
  Plus,
} from "@untitledui/icons";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@decocms/ui/components/alert.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { ScrollArea } from "@decocms/ui/components/scroll-area.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  APPS_SCHEDULING_VERSION,
  APPS_UPDATE_COMMAND,
  type BlogSupport,
  supportsScheduling,
} from "./blog-capabilities";
import {
  addMonths,
  buildMonthWeeks,
  startOfDay,
  startOfMonth,
} from "../variant-calendar/date-utils";
import { listPostsWithMeta } from "./blog-data";
import {
  type CalendarEntry,
  dayKey,
  groupPostsByDay,
} from "./post-calendar-data";

/**
 * Chip tints, keyed off whether the post carries a real schedule. The dashed
 * border is the unscheduled signal, so both use `border` (rings have no dashed
 * style) and selection gets the outer `ring` instead.
 */
const SCHEDULED_CHIP =
  "border-success/30 bg-success/10 text-success hover:bg-success/20";
const UNSCHEDULED_CHIP =
  "border-dashed border-border bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground";

/**
 * Sits over the blurred grid when the site can't back scheduling. Never a CTA
 * — the fix is a command in the repo, not a button here.
 */
function SupportOverlay({ support }: { support: BlogSupport }) {
  const t = useT();
  const runtimeUnsupported = support.kind === "unsupported-runtime";
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/30 p-6">
      <Alert
        variant="warning"
        className="max-w-md bg-background/95 shadow-lg backdrop-blur"
      >
        <AlertCircle />
        <div>
          <AlertTitle>
            {t(
              runtimeUnsupported
                ? "sandbox.postCalendar.unsupportedRuntimeTitle"
                : "sandbox.postCalendar.outdatedAppsTitle",
            )}
          </AlertTitle>
          <AlertDescription>
            {runtimeUnsupported
              ? t("sandbox.postCalendar.unsupportedRuntimeDescription")
              : t("sandbox.postCalendar.outdatedAppsDescription", {
                  required: APPS_SCHEDULING_VERSION,
                })}
          </AlertDescription>
          {!runtimeUnsupported && (
            <code className="mt-2 block rounded-md bg-muted px-2 py-1 font-mono text-xs text-foreground">
              {APPS_UPDATE_COMMAND}
            </code>
          )}
        </div>
      </Alert>
    </div>
  );
}

export function PostCalendar({
  decofile,
  support,
  selectedKey,
  onSelect,
  onCreate,
  onReschedule,
  isCreating = false,
}: {
  decofile: Record<string, unknown>;
  /** Gates the "+" affordance — see {@link supportsScheduling}. */
  support: BlogSupport;
  /** Decofile key of the post currently open in the editor, if any. */
  selectedKey?: string | null;
  onSelect: (key: string) => void;
  /** Create a post scheduled for this day. */
  onCreate: (day: Date) => void;
  /** Move an already-scheduled post's go-live day. */
  onReschedule: (key: string, day: Date) => void;
  isCreating?: boolean;
}) {
  const t = useT();
  const canSchedule = supportsScheduling(support);
  // Set on dragstart so a day cell can highlight only for a real drop.
  const [dragging, setDragging] = useState<string | null>(null);
  const [preferences] = usePreferences();
  const [cursor, setCursor] = useState<Date>(() => startOfMonth(new Date()));

  const locale = preferences.language;
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(cursor);
  const weekdayLabel = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const dayLabel = new Intl.DateTimeFormat(locale, { dateStyle: "long" });

  const { byDay, undated } = groupPostsByDay(listPostsWithMeta(decofile));
  const weeks = buildMonthWeeks(cursor);
  const today = startOfDay(new Date());

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 px-4 h-12 border-b shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCursor(startOfMonth(new Date()))}
        >
          {t("sandbox.postCalendar.today")}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setCursor((c) => addMonths(c, -1))}
          aria-label={t("sandbox.postCalendar.previous")}
        >
          <ChevronLeft size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={() => setCursor((c) => addMonths(c, 1))}
          aria-label={t("sandbox.postCalendar.next")}
        >
          <ChevronRight size={16} />
        </Button>
        <h2 className="ml-2 text-base font-semibold capitalize">
          {monthLabel}
        </h2>
        <div className="ml-auto flex items-center gap-4">
          <LegendItem
            className={SCHEDULED_CHIP}
            label={t("sandbox.postCalendar.legendScheduled")}
          />
          <LegendItem
            className={UNSCHEDULED_CHIP}
            label={t("sandbox.postCalendar.legendUnscheduled")}
          />
        </div>
      </div>

      <div className="relative flex-1 min-h-0">
        <ScrollArea
          className={cn("h-full", !canSchedule && "blur-[2px] select-none")}
          inert={!canSchedule}
        >
          <div className="flex min-w-[880px] gap-4 p-4">
            <div className="flex-1 min-w-0">
              <div className="grid grid-cols-7 mb-2">
                {weeks[0]?.map((day) => (
                  <div
                    key={day.getDay()}
                    className="px-2 text-[11px] uppercase tracking-wider text-muted-foreground"
                  >
                    {weekdayLabel.format(day)}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border">
                {weeks.flat().map((day) => {
                  const inMonth = day.getMonth() === cursor.getMonth();
                  const entries = byDay.get(dayKey(day)) ?? [];
                  return (
                    <div
                      key={day.getTime()}
                      onDragOver={(e) => {
                        if (!dragging) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        const key = e.dataTransfer.getData("text/plain");
                        setDragging(null);
                        if (key) onReschedule(key, day);
                      }}
                      className={cn(
                        "group/day min-h-28 space-y-1 p-2 transition-colors",
                        inMonth ? "bg-background" : "bg-muted/40",
                        dragging && "hover:bg-accent",
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div
                          className={cn(
                            "grid size-6 place-items-center rounded-full text-xs",
                            day.getTime() === today.getTime()
                              ? "bg-primary font-semibold text-primary-foreground"
                              : "text-muted-foreground",
                          )}
                        >
                          {day.getDate()}
                        </div>
                        {canSchedule && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 opacity-0 transition-opacity group-hover/day:opacity-100 focus-visible:opacity-100"
                            disabled={isCreating}
                            onClick={() => onCreate(day)}
                            aria-label={t(
                              "sandbox.postCalendar.schedulePostOn",
                              {
                                date: dayLabel.format(day),
                              },
                            )}
                          >
                            <Plus size={14} />
                          </Button>
                        )}
                      </div>
                      {entries.map((entry) => (
                        <PostChip
                          key={entry.post.key}
                          entry={entry}
                          active={entry.post.key === selectedKey}
                          draggable={canSchedule && entry.scheduled}
                          onSelect={onSelect}
                          onDragStateChange={setDragging}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                {t("sandbox.postCalendar.unscheduledHint")}
              </p>
            </div>

            <div className="w-[220px] shrink-0 space-y-2 self-start rounded-lg border border-dashed p-3">
              <p className="px-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                {t("sandbox.postCalendar.undatedLabel", {
                  count: undated.length,
                })}
              </p>
              {undated.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
                  <CalendarDate
                    size={20}
                    className="text-muted-foreground/60"
                    aria-hidden
                  />
                  <p className="text-xs text-muted-foreground">
                    {t("sandbox.postCalendar.undatedEmpty")}
                  </p>
                </div>
              ) : (
                undated.map((entry) => (
                  <PostChip
                    key={entry.post.key}
                    entry={entry}
                    active={entry.post.key === selectedKey}
                    draggable={false}
                    onSelect={onSelect}
                    onDragStateChange={setDragging}
                  />
                ))
              )}
            </div>
          </div>
        </ScrollArea>
        {!canSchedule && <SupportOverlay support={support} />}
      </div>
    </div>
  );
}

function LegendItem({
  className,
  label,
}: {
  className: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-3 rounded-sm border", className)} />
      {label}
    </span>
  );
}

/**
 * Only a scheduled post is draggable: dragging an unscheduled one would move
 * its editorial `date`, which is a different thing from a go-live day.
 */
function PostChip({
  entry,
  active,
  draggable,
  onSelect,
  onDragStateChange,
}: {
  entry: CalendarEntry;
  active: boolean;
  draggable: boolean;
  onSelect: (key: string) => void;
  onDragStateChange: (key: string | null) => void;
}) {
  const t = useT();
  const { post, scheduled } = entry;
  const status = t(
    scheduled
      ? "sandbox.postCalendar.legendScheduled"
      : "sandbox.postCalendar.legendUnscheduled",
  );
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", post.key);
        e.dataTransfer.effectAllowed = "move";
        onDragStateChange(post.key);
      }}
      onDragEnd={() => onDragStateChange(null)}
      onClick={() => onSelect(post.key)}
      title={`${post.title} · ${status}`}
      className={cn(
        "w-full truncate rounded-md border px-2 py-1 text-left text-xs font-medium transition-colors",
        scheduled ? SCHEDULED_CHIP : UNSCHEDULED_CHIP,
        draggable && "cursor-grab active:cursor-grabbing",
        active && "ring-2 ring-primary",
      )}
    >
      {post.title}
    </button>
  );
}
