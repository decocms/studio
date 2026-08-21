import { useState } from "react";
import { mondayOfWeek, type SprintConfig } from "@decocms/shared/sprints";
import {
  EMPTY_FILTERS,
  TaskFiltersBar,
  type TaskFilters,
} from "@/layouts/task-board/task-filters";

/**
 * Anchored to this week's Monday so "today" is always sprint 1 — the picker
 * reads the real clock, and a fixed start date would make which sprint is
 * current depend on the day the suite runs.
 */
const CONFIG: SprintConfig = {
  enabled: true,
  weeks: 2,
  startDate: mondayOfWeek(new Date()),
};

/** The 13 sprints `sprintOptions` offers over a 20-week horizon at 2 weeks. */
const SPRINTS = Array.from({ length: 13 }, (_, i) => i + 1);

/**
 * CT surface for the board's sprint filter: the real `TaskFiltersBar` with only
 * the sprint control populated. Radix menus open on pointerdown and portal their
 * content, which the happy-dom unit tier never opens — so the picker's row
 * layout is asserted here, in a real browser.
 */
export function SprintFilterHarness() {
  const [filters, setFilters] = useState<TaskFilters>(EMPTY_FILTERS);
  return (
    <div className="w-[560px] bg-background p-6">
      <TaskFiltersBar
        filters={filters}
        members={[]}
        tags={[]}
        repos={[]}
        sprints={SPRINTS}
        sprintConfig={CONFIG}
        onChange={setFilters}
      />
      <pre data-testid="sprint">{JSON.stringify(filters.sprint)}</pre>
    </div>
  );
}
