/**
 * The Tasks board's one list of work buckets — where a repository IS a project.
 *
 * The board used to narrow by two vocabularies that named the same thing. The
 * ambient app-wide scope (`?virtualmcpid=`) spoke PROJECTS; the board's own
 * control (`?repo=`) spoke `owner/name` strings; and two more copies of the
 * repo→project rule lived in the org home's feed and the sidebar's task groups.
 * Four places, three vocabularies, one relation.
 *
 * This is that relation, once. A `ProjectIndexEntry` is a bucket of work: the
 * project you recognize, carrying the repository it pins as a subtitle. Picking
 * one on the board is picking a project — which is what the picker now says,
 * because a repository is how a project is identified on a task, not a second
 * thing to choose.
 *
 * A card's persisted `virtualMcpId` is authoritative. `repo` and linked runs
 * remain as compatibility attribution for rows created before project
 * ownership was stored; repository data still serves execution and display.
 *
 * WHAT IS NOT HERE, deliberately:
 *  - No write to `?virtualmcpid=` from a board control. Coupling the exact
 *    board filter to the inclusive ambient scope is what #6801 removed, and
 *    re-creating it from the other end would hide every repo-less card the
 *    moment a project was picked.
 *
 * Pure and hook-free on purpose: attribution is the feature, and it is a thing
 * a unit test can hold. {@link useProjectIndex} is the React front door.
 */

import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { projectRepo, resolveGithubAttachment } from "./github-repo";

/** A card, as everything here reads one: its stamped repo and its runs. */
export interface AttributableTask {
  virtualMcpId?: string | null;
  repo?: string | null;
  threads?: readonly { virtualMcpId?: string | null }[];
}

/**
 * The board's "no project" bucket. Its WIRE VALUE is unchanged from the repo
 * filter it replaces, so every `?repo=__no_repo__` link anyone has shared keeps
 * selecting the same control.
 */
export const NO_PROJECT_FILTER = "__no_repo__";

/**
 * Repository identity, folded. GitHub treats `owner/repo` case-insensitively
 * and so must every join built on it.
 *
 * Local rather than imported from `@decocms/shared/github-repo-scope`, whose
 * `repoIdentity` is private to that module and composes `owner` and `repo`
 * separately — a card carries the two already joined. The two must agree; they
 * are the same one-line rule.
 */
export function normalizeRepo(label: string | null | undefined): string {
  return (label ?? "").trim().toLowerCase();
}

/**
 * One bucket of work on the board.
 *
 * `kind: "repo"` — keyed by the normalized `owner/name`. `projects` holds EVERY
 * project pinning that repository: none (a repository nobody has made a project
 * of), one (the ordinary case — the entry IS that project), or several (two
 * projects over one monorepo, which the data model has allowed since migration
 * 158 dropped its one-parent trigger).
 *
 * `kind: "project"` — keyed by the `vir_…` id, for a project with no repository.
 * Only a linked thread can put a card here, since `task_board_items.repo` has
 * nothing to point at.
 */
export interface ProjectIndexEntry {
  /** The value the board's `?repo=` param carries for this bucket. */
  id: string;
  kind: "repo" | "project";
  /** `owner/name` in its first-seen display casing, or null for a repo-less project. */
  repo: string | null;
  /** What the picker and the chip read: the project's name, or the repository's. */
  title: string;
  /** Every project in this bucket, `created_at` asc then `id` asc. */
  projects: VirtualMCPEntity[];
}

export interface ProjectIndex {
  /** Projects first (by title), then unclaimed repositories (by label). */
  entries: ProjectIndexEntry[];
  byId: Map<string, ProjectIndexEntry>;
  /** Normalized `owner/name` → entry. */
  byRepo: Map<string, ProjectIndexEntry>;
  /**
   * Project id → its entry. Two projects sharing a repository BOTH map to the
   * same entry, so nothing overwrites anything — which is the whole difference
   * from the `Map<repo, project>` this replaces, where the last project
   * iterated won and its sibling's cards were routed to it silently.
   */
  byProject: Map<string, ProjectIndexEntry>;
  /** Project id (including hidden dev aliases) → the visible project it
   * represents. Unlike `byProject`, this retains identity inside a shared-repo
   * bucket. */
  projectById: Map<string, VirtualMCPEntity>;
}

/** `created_at` asc, `id` asc — so a bucket's representative never depends on
 *  the order its projects happened to arrive in. */
function byCreation(a: VirtualMCPEntity, b: VirtualMCPEntity): number {
  const created = (a.created_at ?? "").localeCompare(b.created_at ?? "");
  return created !== 0 ? created : a.id.localeCompare(b.id);
}

/**
 * A bucket's display name: its project's when exactly one project names it,
 * the repository's otherwise — neither sibling's name is honest for the other's
 * work, and an unclaimed repository has only itself to be called.
 */
function entryTitle(entry: ProjectIndexEntry): string {
  if (entry.projects.length === 1) {
    return entry.projects[0]?.title ?? entry.repo ?? entry.id;
  }
  return entry.repo ?? entry.id;
}

/**
 * The board's buckets, from the org's projects and every repository in play.
 *
 * `extraRepos` is what keeps the index CLOSED over the cards it will be asked
 * about: callers pass every `task.repo` in the loaded list, so a card whose
 * repository no project claims still lands in a bucket instead of falling into
 * "No project". The board additionally passes the org's imported repositories,
 * which can only add empty buckets to the picker — a repository that no card
 * and no project names cannot change any card's attribution.
 */
export function buildProjectIndex(
  projects: readonly VirtualMCPEntity[],
  extraRepos: readonly (string | null | undefined)[] = [],
  aliasCandidates: readonly VirtualMCPEntity[] = [],
): ProjectIndex {
  const byRepo = new Map<string, ProjectIndexEntry>();
  const byProject = new Map<string, ProjectIndexEntry>();
  const projectById = new Map<string, VirtualMCPEntity>();
  const repoless: ProjectIndexEntry[] = [];

  /** The bucket for a repository, created on first sight. Keeps the casing it
   *  was first seen in — the label is for reading, the key is for joining. */
  const repoEntry = (label: string): ProjectIndexEntry => {
    const key = normalizeRepo(label);
    const existing = byRepo.get(key);
    if (existing) return existing;
    const entry: ProjectIndexEntry = {
      id: key,
      kind: "repo",
      repo: label.trim(),
      title: label.trim(),
      projects: [],
    };
    byRepo.set(key, entry);
    return entry;
  };

  for (const project of projects) {
    const repo = projectRepo(project);
    if (repo) {
      const entry = repoEntry(repo);
      entry.projects.push(project);
      byProject.set(project.id, entry);
      projectById.set(project.id, project);
      continue;
    }
    const entry: ProjectIndexEntry = {
      id: project.id,
      kind: "project",
      repo: null,
      title: project.title,
      projects: [project],
    };
    repoless.push(entry);
    byProject.set(project.id, entry);
    projectById.set(project.id, project);
  }

  for (const label of extraRepos) {
    const trimmed = (label ?? "").trim();
    if (trimmed) repoEntry(trimmed);
  }

  for (const entry of byRepo.values()) {
    entry.projects.sort(byCreation);
    entry.title = entryTitle(entry);
  }

  const claimed = [...byRepo.values()].filter((e) => e.projects.length > 0);
  const unclaimed = [...byRepo.values()].filter((e) => e.projects.length === 0);
  const byTitle = (a: ProjectIndexEntry, b: ProjectIndexEntry) =>
    a.title.localeCompare(b.title);
  const entries = [
    ...[...claimed, ...repoless].sort(byTitle),
    ...unclaimed.sort(byTitle),
  ];

  /** Dev entities stay out of visible buckets, but tasks can legitimately
   * persist their ids. Point each alias at its live project's bucket and
   * identity so grouping remains exact even for a shared repository. */
  for (const candidate of aliasCandidates) {
    const metadata = candidate.metadata;
    const liveProjectId =
      typeof metadata === "object" &&
      metadata !== null &&
      "liveAgentId" in metadata &&
      typeof metadata.liveAgentId === "string"
        ? metadata.liveAgentId
        : null;
    if (!liveProjectId || candidate.id === liveProjectId) continue;
    const entry = byProject.get(liveProjectId);
    const project = projectById.get(liveProjectId);
    if (!entry || !project) continue;
    byProject.set(candidate.id, entry);
    projectById.set(candidate.id, project);
  }

  return {
    entries,
    byId: new Map(entries.map((entry) => [entry.id, entry] as const)),
    byRepo,
    byProject,
    projectById,
  };
}

/**
 * Which bucket a card belongs to, or null when nothing says.
 *
 * Persisted owner first. Threads and then `repo` are the legacy-only fallback
 * for cards whose owner is null.
 */
export function entryForTask(
  task: AttributableTask,
  index: ProjectIndex,
): ProjectIndexEntry | null {
  if (task.virtualMcpId) {
    return index.byProject.get(task.virtualMcpId) ?? null;
  }
  for (const thread of task.threads ?? []) {
    const found = thread.virtualMcpId
      ? index.byProject.get(thread.virtualMcpId)
      : undefined;
    if (found) return found;
  }
  const repo = normalizeRepo(task.repo);
  return (repo ? index.byRepo.get(repo) : undefined) ?? null;
}

/**
 * Every project a card can honestly be listed under.
 *
 * A shared bucket with a thread hint resolves to the one project that ran it.
 * A shared bucket without one resolves to BOTH: showing a card twice is honest,
 * showing it once under a project that may not own it is not.
 */
export function projectsForTask(
  task: AttributableTask,
  index: ProjectIndex,
): VirtualMCPEntity[] {
  if (task.virtualMcpId) {
    const project = index.projectById.get(task.virtualMcpId);
    return project ? [project] : [];
  }
  const entry = entryForTask(task, index);
  if (!entry) return [];
  if (entry.projects.length <= 1) return entry.projects;
  for (const thread of task.threads ?? []) {
    const named = thread.virtualMcpId
      ? entry.projects.find((p) => p.id === thread.virtualMcpId)
      : undefined;
    if (named) return [named];
  }
  return entry.projects;
}

/** The single project a card belongs to, or null when the answer is "several"
 *  or "none" — a caller that renders ONE name must be told when there isn't one. */
export function projectForTask(
  task: AttributableTask,
  index: ProjectIndex,
): VirtualMCPEntity | null {
  const named = projectsForTask(task, index);
  return named.length === 1 ? (named[0] ?? null) : null;
}

/**
 * The bucket a filter value names — by bucket id, then by repository, then by
 * project id. All three, because a bucket's id is not stable for the lifetime
 * of a link.
 *
 * The repository lookup makes a `?repo=` link written before any of this
 * existed resolve to a BUCKET rather than a bare string: those carry whatever
 * casing GitHub showed at the time, and `byId` is keyed on the folded form.
 *
 * The project lookup covers the other drift: a project with no repository is
 * keyed by its `vir_…` id, and the day someone imports a repository into it
 * that bucket is re-keyed to `owner/name`. Without this, every link anyone
 * shared while it was repo-less would fall through to the unresolved branch,
 * quietly stop filtering, and say nothing about it.
 */
export function entryForFilter(
  filterId: string,
  index: ProjectIndex,
): ProjectIndexEntry | undefined {
  return (
    index.byId.get(filterId) ??
    index.byRepo.get(normalizeRepo(filterId)) ??
    index.byProject.get(filterId)
  );
}

/**
 * Whether a card survives the board's project filter.
 *
 * The four branches, and why each is what it is:
 *  - No filter: everything.
 *  - {@link NO_PROJECT_FILTER}: the cards no bucket claims. Once the project
 *    list has loaded this is a strict subset of the `repo == null` test it
 *    replaces; on the first frame `byProject` is still empty, so a
 *    thread-attributed card appears here and then leaves.
 *  - A resolved bucket: the card's literal `repo` matches it (the exact test
 *    this replaces) OR the card RESOLVES into it. Since `entryForTask` reads
 *    threads before `repo`, that second clause also admits a card stamped for
 *    another repository that one of this project's runs touched — so buckets
 *    are inclusive, not a partition.
 *  - An id with no bucket: a repo-shaped id falls back to the raw
 *    case-insensitive compare, which is byte-identical to today and right for a
 *    link naming a repository nothing carries. Anything else — an unresolved
 *    `vir_…` id, or the first frame before the project list has loaded —
 *    resolves like an ABSENT filter, the rule `resolveSprintFilter` already
 *    documents for a URL that outlives what it names. Failing closed there
 *    would blank a project-filtered board on every cold load.
 */
export function taskMatchesProjectFilter(
  task: AttributableTask,
  filterId: string | null,
  index: ProjectIndex,
): boolean {
  if (filterId === null) return true;
  if (filterId === NO_PROJECT_FILTER) {
    return !task.virtualMcpId && entryForTask(task, index) === null;
  }

  const entry = entryForFilter(filterId, index);
  if (task.virtualMcpId) {
    const ownerEntry = index.byProject.get(task.virtualMcpId);
    return ownerEntry ? ownerEntry === entry : task.virtualMcpId === filterId;
  }
  if (!entry) {
    if (!filterId.includes("/")) return true;
    return normalizeRepo(task.repo) === normalizeRepo(filterId);
  }
  if (entry.repo && normalizeRepo(task.repo) === normalizeRepo(entry.repo)) {
    return true;
  }
  return entryForTask(task, index) === entry;
}

/**
 * Whether this filter is actually narrowing anything.
 *
 * False for the one id {@link taskMatchesProjectFilter} lets every card
 * through: a `vir_…` the index cannot resolve — the first frame before the
 * project list has loaded, and a link naming a project since deleted. The
 * control must READ the way it behaves; a chip that shows a raw `vir_01j9x…`
 * over an unnarrowed board claims a filter that is not being applied.
 *
 * A repo-shaped id is always narrowing, resolved or not: it falls back to an
 * exact compare against the card's own `repo`, which is a real answer even
 * when nothing in the org declares that repository.
 */
export function projectFilterNarrows(
  filterId: string | null,
  index: ProjectIndex,
): boolean {
  if (filterId === null) return false;
  if (filterId === NO_PROJECT_FILTER) return true;
  return !!entryForFilter(filterId, index) || filterId.includes("/");
}

/**
 * The filter to keep after creating a card, or null to widen back to all.
 *
 * A person who types a task while the board is narrowed must see it appear.
 * The board would rather drop its own filter than swallow the thing you just
 * made — and dropping it is visible, where an empty lane is not.
 */
export function filterAfterCreate(
  created: AttributableTask,
  filterId: string | null,
  index: ProjectIndex,
): string | null {
  if (filterId === null) return null;
  return taskMatchesProjectFilter(created, filterId, index) ? filterId : null;
}

/**
 * The buckets a card can be STAMPED with.
 *
 * A stampable bucket needs a repository for execution, and it must not be one
 * whose connection was torn down. `projectRepo` deliberately still answers
 * for a `detached` project so
 * its existing cards stay visible, but no PR can ever be opened there, and the
 * server refuses to advance a card with `repo != null && !hasPr`. Stamping one
 * parks a card In Progress forever.
 *
 * The test is the project's own attachment, NOT the org's connection list. A
 * list-based gate empties this picker whenever the org reaches its repositories
 * some other way, and again on every frame before that list resolves — which is
 * a worse failure than the one it prevents, because it is the common case.
 */
export function stampableEntries(index: ProjectIndex): ProjectIndexEntry[] {
  return index.entries.filter(
    (entry) =>
      entry.repo !== null &&
      (entry.projects.length === 0 ||
        entry.projects.some(
          (project) => resolveGithubAttachment(project).status !== "detached",
        )),
  );
}
