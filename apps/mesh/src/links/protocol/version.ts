/**
 * Bumped manually whenever a wire-breaking change ships:
 *   - HarnessStreamInput field added/removed in a way old links can't ignore
 *   - SSE dispatch event shape change
 *   - Registration payload schema change
 *   - Daemon route shape change
 *   - AI SDK major version bump (cluster & link pin in lockstep)
 *
 * v2 (hard break): slot-keyed models with per-slot `credentialId`, required
 * symbolic `workspace.cwd`, removal of the singular `modelSource` and the
 * `primary`/`title`/`coding` slots.
 *
 * The daemon advertises this version on every work poll via the
 * `x-link-protocol` header (see `link-daemon/work-poller.ts`).
 */
export const LINK_PROTOCOL_VERSION = 2;

/**
 * Cluster rejects daemons below this with 426 `protocol_mismatch`. Links MUST
 * upgrade. Bumped when an older version becomes too costly to support —
 * v2 refuses v1 daemons outright (the v2 input contract is unintelligible
 * to them). Any rejection surfaced to a stale daemon MUST include the
 * remediation: re-run `bunx decocms@latest link`.
 *
 * Enforced by the version gate in
 * `api/routes/decopilot/link-work-routes.ts` — the work poll is the pull
 * transport's registration/claim path, so gating it keeps stale daemons
 * from ever minting a presence claim (and thus from receiving v2 work
 * items they cannot parse). The daemon's work poller stops polling on a
 * 426 and surfaces the server's remediation message in the `deco link`
 * terminal (see `link-daemon/work-poller.ts`).
 */
export const MIN_SUPPORTED_LINK_PROTOCOL = 2;

/**
 * Header the daemon uses to report its protocol version on daemon-facing
 * routes. Missing or unparsable values are treated as protocol 1 by the
 * cluster gate — pre-v2 daemons never sent the header.
 */
export const LINK_PROTOCOL_HEADER = "x-link-protocol";

export function isVersionAcceptable(reported: number): boolean {
  return reported >= MIN_SUPPORTED_LINK_PROTOCOL;
}
