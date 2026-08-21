import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@decocms/ui/components/dropdown-menu.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { CalendarDate, ChevronDown, Repeat04 } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  useSprintConfigState,
  useUpdateSprintConfig,
} from "@/hooks/use-organization-settings";
import { parseCalendarDay } from "@decocms/shared/organization/schema";
import {
  DEFAULT_SPRINT_WEEKS,
  mondayOfWeek,
  sprintNumberAt,
  sprintRange,
  SPRINT_WEEK_OPTIONS,
  type SprintConfig,
} from "@decocms/shared/sprints";
import { useT } from "@/i18n/use-t.ts";

/**
 * Sprints for the task board: one toggle, plus the cadence it runs on.
 *
 * The cadence is a start day and a length — sprints themselves are derived
 * windows, so there is nothing to create, close or roll over here.
 */
export function SprintSettings() {
  const t = useT();
  const { config: stored, isLoaded } = useSprintConfigState();
  const update = useUpdateSprintConfig();
  // Held while the date input is being typed into — see `commitStartDate`.
  const [startDateDraft, setStartDateDraft] = useState<string | null>(null);

  /** Cadence a first "on" writes: sprint 1 covers the week it was turned on. */
  const config: SprintConfig = stored ?? {
    enabled: false,
    weeks: DEFAULT_SPRINT_WEEKS,
    startDate: mondayOfWeek(new Date()),
  };

  // Writes replace the cadence whole, so one before the first read lands would
  // overwrite it with the seeded default above.
  const busy = update.isPending || !isLoaded;

  const save = (next: Partial<SprintConfig>) =>
    update.mutate(
      { ...config, ...next },
      { onError: () => toast.error(t("settings.sprints.updateError")) },
    );

  /**
   * A native date input reports every keystroke, and the intermediate values
   * are complete valid days — typing 2026 walks through 0002, 0020 and 0202,
   * each of which would persist a cadence and renumber the board. So the field
   * is a draft until focus leaves it.
   */
  const commitStartDate = () => {
    const next = startDateDraft;
    setStartDateDraft(null);
    if (!next || next === config.startDate) return;
    if (parseCalendarDay(next) === null) return;
    save({ startDate: next });
  };

  /** No plural rules in the i18n module, so one week gets its own key. */
  const weeksLabel = (weeks: number) =>
    weeks === 1
      ? t("settings.sprints.weeksValueOne")
      : t("settings.sprints.weeksValue", { count: String(weeks) });

  const current = config.enabled ? sprintNumberAt(config, new Date()) : null;
  const range = current === null ? null : sprintRange(config, current);

  return (
    <SettingsSection
      title={t("settings.sprints.title")}
      description={t("settings.sprints.description")}
    >
      <SettingsCard>
        <SettingsCardItem
          icon={<Repeat04 size={16} />}
          title={t("settings.sprints.enabledTitle")}
          description={t("settings.sprints.enabledDescription")}
          action={
            <Switch
              checked={config.enabled}
              disabled={busy}
              aria-label={t("settings.sprints.enabledTitle")}
              onCheckedChange={(enabled) => save({ enabled })}
            />
          }
        />
        {config.enabled && (
          <SettingsCardItem
            icon={<CalendarDate size={16} />}
            title={t("settings.sprints.cadenceTitle")}
            description={
              current !== null && range
                ? t("settings.sprints.cadenceCurrent", {
                    number: String(current),
                    start: range.start,
                    end: range.end,
                  })
                : t("settings.sprints.cadenceDescription")
            }
          >
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
                  >
                    {weeksLabel(config.weeks)}
                    <ChevronDown size={12} className="opacity-60" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-40">
                  <DropdownMenuRadioGroup
                    value={String(config.weeks)}
                    onValueChange={(next) => save({ weeks: Number(next) })}
                  >
                    {SPRINT_WEEK_OPTIONS.map((weeks) => (
                      <DropdownMenuRadioItem
                        key={weeks}
                        value={String(weeks)}
                        disabled={busy}
                      >
                        {weeksLabel(weeks)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Input
                type="date"
                value={startDateDraft ?? config.startDate}
                disabled={busy}
                aria-label={t("settings.sprints.startDateLabel")}
                onChange={(e) => setStartDateDraft(e.target.value)}
                onBlur={commitStartDate}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                className="h-9 w-40"
              />
            </div>
          </SettingsCardItem>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
