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

import { GitHubIcon } from "@/components/icons/github-icon";
import { ProjectIcon } from "@/components/project-icon";
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

/**
 * A bucket's glyph. `undefined` — an unset control — wears the neutral one.
 *
 * No `className`: the size is {@link ProjectIcon}'s to decide, and the two
 * branches have to occupy the same footprint or a list of buckets steps in and
 * out as you read down it. The GitHub mark is centred in a matching 16px slot
 * rather than filling one — it stays visibly a different ink (it is a filled
 * path where a project's is stroked), which is the point: it means "no single
 * project claims this".
 */
export function ProjectEntryIcon({
  entry,
}: {
  entry: ProjectIndexEntry | undefined;
}) {
  const lead = leadProject(entry);
  if (lead) return <ProjectIcon icon={lead.icon} name={lead.title} />;
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <GitHubIcon className="size-3" />
    </span>
  );
}

/** A bucket as a two-line row: its name, and what it is. */
export function ProjectEntryRow({ entry }: { entry: ProjectIndexEntry }) {
  const subtitle = entrySubtitle(entry);
  return (
    <>
      <ProjectEntryIcon entry={entry} />
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
