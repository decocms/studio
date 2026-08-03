/**
 * Resolve the agent identity used by an existing thread's UI. The URL is a
 * creation hint only; once a row exists, its persisted agent is canonical.
 */
export function resolveThreadVirtualMcpId(
  thread: { virtual_mcp_id?: string } | null | undefined,
  creationHintVirtualMcpId: string,
): string {
  // A malformed existing row must fail closed instead of silently borrowing
  // a different identity from the URL.
  return thread ? (thread.virtual_mcp_id ?? "") : creationHintVirtualMcpId;
}

/** A hosted thread captures its runtime on the first accepted submit. */
export function isHostedFirstSubmit(
  thread: { harness_id?: string | null } | null | undefined,
): boolean {
  return !thread?.harness_id;
}
