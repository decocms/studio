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
  useSprintConfig,
  useUpdateSprintConfig,
} from "@/hooks/use-organization-settings";
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
  const stored = useSprintConfig();
  const update = useUpdateSprintConfig();

  /** Cadence a first "on" writes: sprint 1 covers the week it was turned on. */
  const config: SprintConfig = stored ?? {
    enabled: false,
    weeks: DEFAULT_SPRINT_WEEKS,
    startDate: mondayOfWeek(new Date()),
  };

  const save = (next: Partial<SprintConfig>) =>
    update.mutate(
      { ...config, ...next },
      { onError: () => toast.error(t("settings.sprints.updateError")) },
    );

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
              disabled={update.isPending}
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
                        disabled={update.isPending}
                      >
                        {weeksLabel(weeks)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              <Input
                type="date"
                value={config.startDate}
                disabled={update.isPending}
                aria-label={t("settings.sprints.startDateLabel")}
                // A half-typed day would renumber every sprint on the board.
                onChange={(e) => {
                  const next = e.target.value;
                  if (/^\d{4}-\d{2}-\d{2}$/.test(next)) {
                    save({ startDate: next });
                  }
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
