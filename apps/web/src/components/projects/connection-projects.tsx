/**
 * Which projects use a connection — the question someone asks before revoking
 * one. Each card carries the projects that aggregate it, or "shared" when
 * nothing claims it, read off the project list the page already loads.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { AgentAvatar } from "@/components/agent-icon";
import { useT } from "@/i18n/use-t.ts";

/** Marks shown before the row collapses into a count. */
const MAX_MARKS = 3;

/** Connection id → the projects aggregating it. Pure and tested: a wrong
 *  attribution is a credential revoked in the belief nothing uses it. */
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
            /** A ring in the card's colour, so overlapping marks stay
             *  separate. */
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
