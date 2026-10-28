/**
 * The Monitor's one filter: every project at once, or one of them, for every
 * tab alike. It lives in the panel's top bar and in the URL (`?project=`).
 * Inside a project, and in an org with a single project, there is nothing to
 * choose and it isn't drawn.
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

/**
 * The project every tab reads: the route's own, the org's only one, or the
 * filter's pick. Null is every project at once.
 */
export function monitorScope(
  routeScope: string | null,
  projects: readonly SiteProject[],
  picked: string | undefined,
): string | null {
  if (routeScope) return routeScope;
  if (projects.length === 1) return projects[0]?.id ?? null;
  return projects.some((p) => p.id === picked) ? (picked ?? null) : null;
}
