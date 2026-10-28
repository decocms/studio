/**
 * The Monitor's project filter, a shortcut to the sidebar: picking a project
 * moves into it as clicking it in the sidebar would, and "All projects" goes
 * back to the org. An org with a single project has nothing to pick and it
 * isn't drawn.
 */

import { Page } from "@/components/page";
import { useT } from "@/i18n/use-t.ts";
import type { SiteProject } from "./org-insights";
import { TopbarSelect } from "./topbar-select";

const ALL = "__all";

export function ProjectFilter({
  projects,
  value,
  onChange,
}: {
  projects: readonly SiteProject[];
  value: string | null;
  onChange: (projectId: string | null) => void;
}) {
  const t = useT();
  return (
    <Page.Actions>
      <TopbarSelect
        label={t("monitor.projectFilter.label")}
        value={value ?? ALL}
        options={[
          { value: ALL, label: t("monitor.projectFilter.all") },
          ...projects.map((p) => ({ value: p.id, label: p.title })),
        ]}
        onChange={(next) => onChange(next === ALL ? null : next)}
      />
    </Page.Actions>
  );
}

/** The project every tab reads: the route's own, or the org's only one. */
export function monitorScope(
  routeScope: string | null,
  projects: readonly SiteProject[],
): string | null {
  if (routeScope) return routeScope;
  return projects.length === 1 ? (projects[0]?.id ?? null) : null;
}
