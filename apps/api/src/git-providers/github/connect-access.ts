/**
 * What a connecting GitHub user may delegate, and the per-flow cache that
 * keeps the chooser from asking GitHub the same question on every page,
 * keystroke, and tab focus.
 *
 * The rule is the one GitHub applies to installing an App: a repository is
 * delegable when the user administers it. `GET /user/installations/{id}/
 * repositories` reports that per repository, so it also covers owners (admin
 * on everything) and personal accounts (a collaborator on a personal repo is
 * never admin) without a `/user` or memberships lookup.
 *
 * A connect flow lives ten minutes and belongs to one user, so its results are
 * cached under the flow id for that long. The chooser's refresh path drops the
 * entry; the connect itself re-reads GitHub, never the cache.
 */

import { z } from "zod";
import { matchesRepoQuery } from "./client";
import type { GithubInstallation } from "./app-auth";

/** GitHub's maximum, and the chooser's page size. */
export const CHOICE_PAGE_SIZE = 100;

export interface RepositoryChoice {
  id: number;
  name: string;
}

/** One page of `GET /user/installations/{id}/repositories`. */
export const InstallationRepositoriesPageSchema = z.object({
  total_count: z.number().int().nonnegative().optional(),
  repositories: z.array(
    z.object({
      id: z.number().int().positive().safe(),
      full_name: z.string().min(1),
      permissions: z.object({ admin: z.boolean().optional() }).optional(),
    }),
  ),
});

export type InstallationRepositoriesPage = z.infer<
  typeof InstallationRepositoriesPageSchema
>;

/** The repositories of a page the user administers, in GitHub's order. */
export function delegableRepositories(
  page: InstallationRepositoriesPage,
): RepositoryChoice[] {
  return page.repositories
    .filter((repo) => repo.permissions?.admin === true)
    .map((repo) => ({ id: repo.id, name: repo.full_name }));
}

/**
 * How many more pages follow the first. GitHub sends `total_count`; without
 * it a full page means "maybe more", which the walker resolves sequentially.
 */
export function remainingPages(first: InstallationRepositoriesPage): number {
  if (first.total_count === undefined) return -1;
  return Math.max(0, Math.ceil(first.total_count / CHOICE_PAGE_SIZE) - 1);
}

/**
 * Whether the first page alone proves the user administers nothing in the
 * installation. Only a page that is the whole listing can prove that; a
 * partial page defers to the picker, which walks the rest.
 */
export function provesNothingDelegable(
  first: InstallationRepositoriesPage,
): boolean {
  return (
    remainingPages(first) === 0 && delegableRepositories(first).length === 0
  );
}

/**
 * One page of choices over the full in-memory list. The query matches
 * `owner/name` substrings across every repository, so an empty page means no
 * match anywhere, and `hasMore` reflects matches, not the raw listing.
 */
export function pageChoices(
  choices: RepositoryChoice[],
  page: number,
  query?: string,
): { repositories: RepositoryChoice[]; hasMore: boolean } {
  const matching = choices.filter((repo) => matchesRepoQuery(repo.name, query));
  const start = (page - 1) * CHOICE_PAGE_SIZE;
  return {
    repositories: matching.slice(start, start + CHOICE_PAGE_SIZE),
    hasMore: matching.length > start + CHOICE_PAGE_SIZE,
  };
}

/** Whether every selected id is a delegable repository. */
export function coversSelection(
  choices: RepositoryChoice[],
  repositoryIds: number[],
): boolean {
  const delegable = new Set(choices.map((repo) => repo.id));
  return repositoryIds.every((id) => delegable.has(id));
}

interface FlowAccessEntry {
  expiresAt: number;
  installations?: GithubInstallation[];
  repositories: Map<number, RepositoryChoice[]>;
}

/**
 * Per-flow memory of what GitHub answered. Entries expire with the flow;
 * `forget` drops one when the chooser refreshes or the flow ends. Pruned on
 * every write so abandoned flows do not accumulate.
 */
export class FlowAccessCache {
  private readonly entries = new Map<string, FlowAccessEntry>();

  constructor(private readonly ttlMs: number) {}

  installations(flowId: string): GithubInstallation[] | undefined {
    return this.live(flowId)?.installations;
  }

  repositories(
    flowId: string,
    installationId: number,
  ): RepositoryChoice[] | undefined {
    return this.live(flowId)?.repositories.get(installationId);
  }

  rememberInstallations(
    flowId: string,
    installations: GithubInstallation[],
  ): void {
    this.entry(flowId).installations = installations;
  }

  rememberRepositories(
    flowId: string,
    installationId: number,
    repositories: RepositoryChoice[],
  ): void {
    this.entry(flowId).repositories.set(installationId, repositories);
  }

  forget(flowId: string): void {
    this.entries.delete(flowId);
  }

  private live(flowId: string): FlowAccessEntry | undefined {
    const entry = this.entries.get(flowId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(flowId);
      return undefined;
    }
    return entry;
  }

  private entry(flowId: string): FlowAccessEntry {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    let entry = this.entries.get(flowId);
    if (!entry) {
      entry = { expiresAt: now + this.ttlMs, repositories: new Map() };
      this.entries.set(flowId, entry);
    }
    return entry;
  }
}
