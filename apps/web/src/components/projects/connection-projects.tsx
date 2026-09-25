/**
 * Which projects use a connection — the org-level half of per-project
 * connections.
 *
 * A project has been able to pick its own connections for a while; what was
 * missing is the view from the other side. An org with a VTEX account per
 * brand and two analytics properties has no way, from Settings › Connections,
 * to tell which credential feeds which storefront — and that is exactly the
 * question someone asks before they revoke one.
 *
 * So each connection card carries the projects that aggregate it: their marks,
 * their names, and "shared" when nothing claims it. Read from the project list
 * the page already loads, so it costs no request.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import { useT } from "@/i18n/use-t.ts";

/** Marks shown before the row collapses into a count. */
const MAX_MARKS = 3;

/**
 * Connection id → the projects aggregating it.
 *
 * Pure and exported for its test: a connection attributed to the wrong project
 * is a credential someone revokes believing nothing depends on it.
 */
export function projectsByConnection(
  projects: readonly VirtualMCPEntity[],
): Map<string, VirtualMCPEntity[]> {
  const out = new Map<string, VirtualMCPEntity[]>();
  for (const project of projects) {
    for (const connection of project.connections ?? []) {
      const bucket = out.get(connection.connection_id) ?? [];
      bucket.push(project);
      out.set(connection.connection_id, bucket);
    }
  }
  return out;
}

export function ConnectionProjects({
  projects,
}: {
  projects: readonly VirtualMCPEntity[];
}) {
  const t = useT();

  if (projects.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("projects.connections.orgWide")}
      </span>
    );
  }

  const shown = projects.slice(0, MAX_MARKS);
  const rest = projects.length - shown.length;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {/* Overlapped marks, so the row stays one line however many there are. */}
      <div className="flex shrink-0 -space-x-1.5">
        {shown.map((project) => (
          <span
            key={project.id}
            /** A ring in the card's own colour, so overlapping marks read as
             *  separate objects rather than one smeared shape. */
            className="rounded-md ring-2 ring-card"
            title={project.title}
          >
            <AgentAvatar icon={project.icon} name={project.title} size="xs" />
          </span>
        ))}
      </div>
      <span className="truncate text-xs text-muted-foreground">
        {projects.length === 1
          ? projects[0]?.title
          : t("projects.connections.usedBy", { count: projects.length })}
      </span>
      {rest > 0 && <span className="sr-only">{rest}</span>}
    </div>
  );
}
