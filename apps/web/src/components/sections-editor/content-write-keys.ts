/**
 * The pieces every content backend's writes share, with no network: the
 * scope a write names, the patch body, and the mutation key and
 * serialization scope that make writes run one at a time and let observers
 * (the autosave indicator) see them. Both the v7 git client
 * (`decofile-api.ts`) and the hosted CMS client (`content-protocol-api.ts`)
 * use them, so the hosted one needn't import the git client
 * (`plugins/ban-cms-git-imports.js`).
 */

export interface DecofileScopeParams {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

export interface DecofilePatchBody {
  set?: Record<string, unknown>;
  delete?: string[];
  /** Per block: fingerprint of the version the edit was made against, `null` for none. */
  expect?: Record<string, string | null>;
}

/**
 * Mutation key for block save/delete writes. Lets observers (the preview's
 * autosave indicator via useIsMutating) see an in-flight write without any
 * bespoke wiring — same pattern as SANDBOX_START_MUTATION_KEY.
 */
export function decofileWriteMutationKey(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
) {
  return ["decofile-write", orgSlug, virtualMcpId, branch] as const;
}

/**
 * Serialization scope for those writes. TanStack runs mutations sharing a
 * `scope.id` one at a time; `mutationKey` alone only identifies them. Every
 * hook that WRITES the decofile must pass this, or it races the others — an
 * autosave landing after a delete resurrects the block that was just removed.
 * Observers (`useIsMutating`) need the key only.
 */
export function decofileWriteScope(
  orgSlug: string,
  virtualMcpId: string,
  branch: string,
) {
  return {
    id: decofileWriteMutationKey(orgSlug, virtualMcpId, branch).join(":"),
  };
}
