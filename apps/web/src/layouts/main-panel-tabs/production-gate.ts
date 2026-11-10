/**
 * Whether the site editor may show a session's content. A Blocks v7 Fast
 * Preview draft IS a git branch, so a session on the repository's default
 * branch would save straight to production: it shows a notice to start a
 * draft instead (the API refuses those writes too). A v8 site edits a CDN
 * draft even on the default branch, and Local mode never saves, so both stay
 * open.
 */
export type ProductionGate = "open" | "pending" | "blocked";

export interface ProductionGateInput {
  runtime: string | null | undefined;
  /** The runtime answer is authoritative (`useSessionRuntime().resolved`). */
  runtimeResolved: boolean;
  /** The project's "Blocks v8 site" switch (`useBlocksV8Project`). */
  blocksV8: boolean;
  /** The preview runs from a local tunnel: edits are ephemeral there. */
  localPreview: boolean;
  /** A connected `deco serve` edits the working tree on this computer. */
  servingLocally: boolean;
  branch: string | null | undefined;
  /** The branch is one of the project's listed drafts. */
  listedDraft: boolean;
  /** The repository's default branch: `undefined` until read, `null` when it couldn't be. */
  defaultBranch: string | null | undefined;
}

export function resolveProductionGate(
  input: ProductionGateInput,
): ProductionGate {
  if (input.servingLocally || input.localPreview) return "open";
  if (!input.runtimeResolved) return "pending";
  if (input.runtime !== "cms") return "open";
  // A CMS session always gets a branch; until it lands there's nothing to edit.
  if (!input.branch) return "pending";
  if (input.blocksV8) return "open";
  if (input.defaultBranch) {
    return input.defaultBranch === input.branch ? "blocked" : "open";
  }
  // A listed draft doesn't wait for the default branch: should it turn out to
  // be production, that answer blocks it then. Unreadable opens too — the
  // API still refuses a write to production.
  return input.listedDraft || input.defaultBranch === null ? "open" : "pending";
}
