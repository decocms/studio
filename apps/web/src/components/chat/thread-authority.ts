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

export type ThreadMutationAuthority =
  | { kind: "new" }
  | { kind: "existing"; createdBy: string | null | undefined }
  | { kind: "unresolved" };

/**
 * Resolve the authority subject independently from the viewer. A missing URL
 * id is the explicit new-thread creation state. Once an id was requested, a
 * missing or mismatched row is unresolved and must not inherit creation
 * authority while route data catches up.
 */
export function resolveThreadMutationAuthority(
  requestedThreadId: string | null | undefined,
  thread: { id?: string | null; created_by?: string | null } | null | undefined,
): ThreadMutationAuthority {
  if (!requestedThreadId) {
    return thread ? { kind: "unresolved" } : { kind: "new" };
  }
  if (!thread || thread.id !== requestedThreadId) {
    return { kind: "unresolved" };
  }
  return { kind: "existing", createdBy: thread.created_by };
}

/** Whether the current viewer may mutate the resolved thread workspace. */
export function canMutateThread(
  authority: ThreadMutationAuthority,
  userId: string | null | undefined,
): boolean {
  if (!userId || authority.kind === "unresolved") return false;
  if (authority.kind === "new") return true;
  return !!authority.createdBy && authority.createdBy === userId;
}

/**
 * Interactive MCP apps receive a live client that can call tools. Require an
 * explicit thread-mutation grant so provider-less read-only renderers (for
 * example Monitor) keep showing serialized output without mounting the app.
 */
export function canRenderInteractiveThreadApp(
  task: { canMutateThread?: boolean } | null | undefined,
): boolean {
  return task?.canMutateThread === true;
}

/** A hosted thread captures its runtime on the first accepted submit. */
export function isHostedFirstSubmit(
  thread: { harness_id?: string | null } | null | undefined,
): boolean {
  return !thread?.harness_id;
}
