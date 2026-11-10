import type { Release } from "@decocms/shared/sdk/types";
import type { StoreDraft } from "./cms-store-drafts.ts";

/**
 * What the version switcher says the current version is. The base branch is
 * read-only production, except where it holds a draft: a hosted Blocks v8
 * editor on the base branch edits a CDN draft (`baseIsDraft`), so it is shown
 * as that draft (an unlisted "Draft" entry, or its named release), never as
 * "Production". v7 passes no `baseIsDraft` and keeps main's labels.
 * A draft the hosted CMS holds but no release names (`deco push --draft`)
 * is `storeDraft`, shown by its own name, not as an unnamed "Draft".
 */
export function pickerCurrent(params: {
  value: string | null | undefined;
  baseBranch: string | null | undefined;
  releases: readonly Release[];
  baseIsDraft?: boolean;
  /** The CMS's drafts no release names ({@link unlistedStoreDrafts}). */
  storeDrafts?: readonly StoreDraft[];
}): {
  isBase: boolean;
  current: Release | undefined;
  storeDraft?: StoreDraft;
  unlisted: boolean;
} {
  const {
    value,
    baseBranch,
    releases,
    baseIsDraft = false,
    storeDrafts = [],
  } = params;
  const isBase = !baseIsDraft && !!value && value === baseBranch;
  const current = releases.find((r) => r.branch === value);
  const storeDraft =
    isBase || current ? undefined : storeDrafts.find((d) => d.name === value);
  // Current branch that is neither base nor a stored release nor a CMS
  // draft: show as a draft.
  const unlisted = !isBase && !current && !storeDraft && !!value;
  return storeDraft
    ? { isBase, current, storeDraft, unlisted }
    : { isBase, current, unlisted };
}
