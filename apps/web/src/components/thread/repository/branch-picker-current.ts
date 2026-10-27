import type { Release } from "@decocms/shared/sdk/types";

/**
 * What the version switcher says the current version is. The base branch is
 * read-only production, except where it holds a draft: a hosted Blocks v8
 * editor on the base branch edits a CDN draft (`baseIsDraft`), so it is shown
 * as that draft (an unlisted "Draft" entry, or its named release), never as
 * "Production". v7 passes no `baseIsDraft` and keeps main's labels.
 */
export function pickerCurrent(params: {
  value: string | null | undefined;
  baseBranch: string | null | undefined;
  releases: readonly Release[];
  baseIsDraft?: boolean;
}): { isBase: boolean; current: Release | undefined; unlisted: boolean } {
  const { value, baseBranch, releases, baseIsDraft = false } = params;
  const isBase = !baseIsDraft && !!value && value === baseBranch;
  const current = releases.find((r) => r.branch === value);
  // Current branch that is neither base nor a stored release: show as a draft.
  const unlisted = !isBase && !current && !!value;
  return { isBase, current, unlisted };
}
