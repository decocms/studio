/**
 * A repository's issues, as an intention rather than one provider's object
 * model — the fifth contract next to `content.ts`, `change-requests.ts` and
 * `insights.ts`.
 *
 * What repository upkeep needs (`docs/plans/repo-upkeep.md`): list the open
 * ones, re-read one before acting on it, explain the action in a comment, and
 * close it. Only GitHub implements it so far. A repository whose provider has
 * no issue client reads like one with issues turned off.
 */

import type { RepoRef } from "@decocms/shared/git-providers";

/** Ceiling on issues one listing returns. */
export const MAX_ISSUES_LISTED = 100;

export interface Issue {
  number: number;
  url: string;
  title: string;
  body: string;
  state: "open" | "closed";
  /** Null when the account is gone ("ghost"). */
  author: string | null;
  labels: string[];
  comments: number;
  createdAt: string;
  updatedAt: string;
}

/** Why an issue was closed, in the two words every provider has. */
export type IssueCloseReason = "completed" | "not_planned";

export interface IssueClient {
  readonly repo: RepoRef;

  /**
   * Open issues, most recently updated first, capped at
   * `min(limit, MAX_ISSUES_LISTED)`. Throws when the repository cannot be
   * read: "could not look" must never read as "no issues".
   */
  listOpen(limit: number): Promise<Issue[]>;

  /** One issue by number, or null when there is none (or it is a change request). */
  read(number: number): Promise<Issue | null>;

  comment(number: number, body: string): Promise<void>;

  close(number: number, reason: IssueCloseReason): Promise<void>;
}
