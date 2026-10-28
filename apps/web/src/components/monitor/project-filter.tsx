/**
 * The Monitor's one filter: every project at once, or one of them, for every
 * tab alike. It lives in the panel's top bar and in the URL (`?project=`).
 * Inside a project, and in an org with a single project, there is nothing to
 * choose and it isn't drawn.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Page } from "@/components/page";
import { useT } from "@/i18n/use-t.ts";
import type { SiteProject } from "./org-insights";

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
      <Select
        value={value ?? ALL}
        onValueChange={(next) => onChange(next === ALL ? null : next)}
      >
        <SelectTrigger size="sm" aria-label={t("monitor.projectFilter.label")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL}>{t("monitor.projectFilter.all")}</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
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
