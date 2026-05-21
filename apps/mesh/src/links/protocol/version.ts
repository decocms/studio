/**
 * Bumped manually whenever a wire-breaking change ships:
 *   - HarnessStreamInput field added/removed in a way old links can't ignore
 *   - SSE dispatch event shape change
 *   - Registration payload schema change
 *   - Daemon route shape change
 *   - AI SDK major version bump (cluster & link pin in lockstep)
 */
export const LINK_PROTOCOL_VERSION = 1;

/**
 * Cluster rejects link registrations below this with 426. Links MUST
 * upgrade. Bumped when an older version becomes too costly to support
 * (typically every 2-3 majors).
 */
export const MIN_SUPPORTED_LINK_PROTOCOL = 1;

export function isVersionAcceptable(reported: number): boolean {
  return reported >= MIN_SUPPORTED_LINK_PROTOCOL;
}
