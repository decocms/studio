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
 */
export const LINK_PROTOCOL_VERSION = 2;

/**
 * Cluster rejects link registrations below this with 426. Links MUST
 * upgrade. Bumped when an older version becomes too costly to support —
 * v2 refuses v1 daemons outright (the v2 input contract is unintelligible
 * to them). Any rejection surfaced to a stale daemon MUST include the
 * remediation: re-run `bunx decocms@latest link`.
 */
export const MIN_SUPPORTED_LINK_PROTOCOL = 2;

export function isVersionAcceptable(reported: number): boolean {
  return reported >= MIN_SUPPORTED_LINK_PROTOCOL;
}
