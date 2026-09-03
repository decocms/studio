/**
 * How a project index bucket presents itself, in one place.
 *
 * A bucket is a project you recognize, carrying the repository it pins — so it
 * wears the PROJECT's avatar and name whenever exactly one project claims it,
 * and falls back to the GitHub glyph only when there is no single project to
 * name: a repository nobody has made a project of, or a monorepo two projects
 * share, where neither sibling's identity is honest for the other's work.
 *
 * Shared by the board's filter and the task detail's picker. Those had the same
 * rule written twice and already disagreed — the picker showed a GitHub glyph
 * beside a label that said "Marketing Site" — which is the same duplication
 * `lib/project-index.ts` exists to remove, one layer up.
 */

import { AgentAvatar } from "@/components/agent-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { ProjectIndexEntry } from "@/lib/project-index";

/** The single project that gives a bucket its identity, or undefined when the
 *  bucket is a bare repository or a monorepo several projects share. */
function leadProject(entry: ProjectIndexEntry | undefined) {
  return entry?.projects.length === 1 ? entry.projects[0] : undefined;
}

/** The line under a bucket's name: its repository when one project owns it,
 *  its projects when several do, nothing when it is a bare repository (whose
 *  name IS the repository). */
function entrySubtitle(entry: ProjectIndexEntry): string | null {
  if (leadProject(entry)) return entry.repo;
  if (entry.projects.length > 1) {
    return entry.projects.map((project) => project.title).join(", ");
  }
  return null;
}

/** A bucket's glyph. `undefined` — an unset control — wears the neutral one. */
export function ProjectEntryIcon({
  entry,
  className,
}: {
  entry: ProjectIndexEntry | undefined;
  className?: string;
}) {
  const lead = leadProject(entry);
  if (!lead) return <GitHubIcon className={cn("shrink-0", className)} />;
  return (
    <AgentAvatar
      icon={lead.icon}
      name={lead.title}
      size="2xs"
      className={cn("shrink-0", className)}
    />
  );
}

/** A bucket as a two-line row: its name, and what it is. */
export function ProjectEntryRow({ entry }: { entry: ProjectIndexEntry }) {
  const subtitle = entrySubtitle(entry);
  return (
    <>
      <ProjectEntryIcon entry={entry} className="size-4" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{entry.title}</span>
        {subtitle && (
          <span className="truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </span>
    </>
  );
}
