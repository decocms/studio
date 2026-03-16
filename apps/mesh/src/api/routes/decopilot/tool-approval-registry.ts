/**
 * Tool Approval Registry
 *
 * In-memory registry of pending tool approval requests for Claude Code streams.
 * When the SDK's canUseTool callback fires, a Promise is created and stored here.
 * The resolution endpoint resolves the Promise when the user clicks approve/deny.
 */

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
}

interface PendingApproval {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

// Keyed by `${threadId}:${approvalId}`
const pending = new Map<string, PendingApproval>();

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function key(threadId: string, approvalId: string): string {
  return `${threadId}:${approvalId}`;
}

/**
 * Create a pending approval and return a Promise that resolves when the user responds.
 */
export function createPendingApproval(
  threadId: string,
  approvalId: string,
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    const k = key(threadId, approvalId);

    // Auto-deny after timeout so the SDK doesn't hang forever
    const timer = setTimeout(() => {
      pending.delete(k);
      resolve({ approved: false, reason: "Approval timed out" });
    }, APPROVAL_TIMEOUT_MS);

    pending.set(k, { resolve, timer });
  });
}

/**
 * Resolve a pending approval with the user's decision.
 * Returns true if the approval was found and resolved.
 */
export function resolvePendingApproval(
  threadId: string,
  approvalId: string,
  decision: ApprovalDecision,
): boolean {
  const k = key(threadId, approvalId);
  const entry = pending.get(k);
  if (!entry) return false;

  clearTimeout(entry.timer);
  pending.delete(k);
  entry.resolve(decision);
  return true;
}

/**
 * Clean up all pending approvals for a thread (e.g. on cancel/abort).
 */
export function clearThreadApprovals(threadId: string): void {
  for (const [k, entry] of pending) {
    if (k.startsWith(`${threadId}:`)) {
      clearTimeout(entry.timer);
      pending.delete(k);
      entry.resolve({ approved: false, reason: "Stream cancelled" });
    }
  }
}
