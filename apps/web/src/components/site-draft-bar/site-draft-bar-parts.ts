/**
 * Which pieces the site's draft bar shows: the content version, the "local
 * files" badge and changes, the environment (draft) select and the Publish
 * actions. Pure, so the one rule every view that edits the site's draft (the
 * site editor, Experiments, Calendar) follows is tested once.
 */
export interface SiteDraftBarInput {
  /** The project's agent resolved (a project, not the account-less editor). */
  hasEntity: boolean;
  /** A connected `deco serve` edits the working tree on this computer. */
  servingLocally: boolean;
  /** The preview runs from a local tunnel: edits are ephemeral there. */
  localPreview: boolean;
  /** A saved tunnel is still waiting for main's answer. */
  tunnelUndecided: boolean;
  /** The agent's repository supports the Publish actions. */
  showsRepositoryActions: boolean;
  runtime: string | null | undefined;
}

export interface SiteDraftBarParts {
  /** Nothing to show (no project, nothing served). */
  hidden: boolean;
  localFiles: boolean;
  draftSelect: boolean;
  /** Which Publish actions: the content site's (`cms`), the code's, or none. */
  publish: "cms" | "code" | null;
}

export function siteDraftBarParts(input: SiteDraftBarInput): SiteDraftBarParts {
  const hidden = !input.hasEntity && !input.servingLocally;
  // Local mode edits are ephemeral (nothing to promote) → no Publish. A saved
  // tunnel waiting for main's answer withholds it too, so a v7 site with a
  // tunnel never shows it first and hides it after. A connected `deco serve`
  // edits the working tree: the developer commits.
  const publishable =
    input.hasEntity &&
    !input.localPreview &&
    !input.tunnelUndecided &&
    !input.servingLocally &&
    input.showsRepositoryActions;
  return {
    hidden,
    localFiles: !hidden && input.servingLocally,
    draftSelect: !hidden && input.hasEntity,
    publish:
      hidden || !publishable ? null : input.runtime === "cms" ? "cms" : "code",
  };
}
