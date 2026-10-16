/**
 * A message sent while a hosted claude-code run is working, delivered into that
 * run instead of queued as the next turn. Behind the organization flag
 * `claude_code_live_messages`.
 *
 * The path: the messages route persists the user row (once, with the target
 * run in `metadata.liveRunId`), then posts the text to the daemon of the run's
 * sandbox (`POST /_sandbox/runs/:runId/messages`). The daemon answers only after
 * the harness took it into the running turn. The harness then emits a
 * `data-live-message` part at the point the model read it, which is where the
 * chat shows the message. Anything that cannot be delivered — the flag is off,
 * the run just ended, the pod refuses — is stripped of its `liveRunId` and
 * queued exactly as before, so nothing is lost.
 */

import { orgFlagEnabled } from "@decocms/shared/organization/schema";
import type { RepositoryBinding } from "@decocms/shared/sdk";
import type { StudioContext } from "@/core/studio-context";
import { getAgentSandboxProvider } from "@/sandbox/lifecycle";
import type { Thread } from "@/storage/types";
import { findRecordedSandbox } from "@/tools/sandbox/recorded-sandbox";
import { resolveSandboxBranchForThread } from "@/tools/sandbox/thread-repo";
import { resolveEffectiveStudioPackVirtualMcp } from "@/tools/virtual/studio-pack";

/** Longest text a live message may carry; a longer one is queued instead. */
const MAX_LIVE_MESSAGE_CHARS = 32_000;

/** The daemon run a turn's harness runs as: one per turn, keyed by its fence. */
export function daemonRunId(threadId: string, fenceToken: string): string {
  return `${threadId}:${fenceToken}`;
}

export async function liveMessagesEnabled(
  ctx: StudioContext,
  organizationId: string,
): Promise<boolean> {
  try {
    const settings = await ctx.storage.organizationSettings.get(organizationId);
    return orgFlagEnabled(settings?.flags, "claude_code_live_messages");
  } catch (err) {
    console.warn("[live-messages] flag read failed", err);
    return false;
  }
}

/**
 * The text a message carries into a running turn, or null when it cannot go
 * live: only text travels on the harness's input, so a message with a file or
 * any other part is queued, where the whole message reaches the model.
 */
function liveMessageText(message: {
  role: string;
  parts?: ReadonlyArray<{ type?: string; text?: unknown }>;
}): string | null {
  if (message.role !== "user") return null;
  const parts = message.parts ?? [];
  if (parts.length === 0) return null;
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") return null;
    texts.push(part.text);
  }
  const text = texts.join("\n");
  if (text.trim().length === 0 || text.length > MAX_LIVE_MESSAGE_CHARS) {
    return null;
  }
  return text;
}

/** The run a persisted message was delivered into, from its metadata. */
export function liveRunIdOf(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const value = (metadata as { liveRunId?: unknown }).liveRunId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

type LiveMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  parts?: unknown[];
  metadata?: unknown;
};

function withLiveRunId<M extends LiveMessage>(
  message: M,
  liveRunId: string | null,
): M {
  const { liveRunId: _drop, ...rest } =
    typeof message.metadata === "object" && message.metadata !== null
      ? (message.metadata as Record<string, unknown>)
      : {};
  return {
    ...message,
    metadata: liveRunId ? { ...rest, liveRunId } : rest,
  };
}

/** Past the daemon's own wait for the runner's ack (30s), so its answer arrives. */
const LIVE_MESSAGE_TIMEOUT_MS = 40_000;

/**
 * Hand a message to the harness running `runId`. True only when the daemon says
 * the running turn took it; every other answer — no such run, a turn that is
 * finishing, an unreachable pod — is false. Idempotent per message id on the
 * daemon side.
 */
async function postDaemonLiveMessage(
  provider: Pick<
    Awaited<ReturnType<typeof getAgentSandboxProvider>>,
    "proxyDaemonRequest"
  >,
  handle: string,
  runId: string,
  message: { id: string; text: string },
): Promise<boolean> {
  try {
    const res = await provider.proxyDaemonRequest(
      handle,
      `/_sandbox/runs/${encodeURIComponent(runId)}/messages`,
      {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(LIVE_MESSAGE_TIMEOUT_MS),
      },
    );
    if (res.ok) return true;
    console.warn("[live-messages] daemon refused", {
      runId,
      status: res.status,
      detail: (await res.text().catch(() => "")).slice(0, 200),
    });
    return false;
  } catch (err) {
    console.warn("[live-messages] daemon unreachable", {
      runId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * The sandbox the thread's run is in, found the way dispatch provisions it but
 * never provisioning one: a run that is working already has its pod.
 */
export async function liveRunSandbox(
  ctx: StudioContext,
  args: { threadId: string; agentId: string; runBranch: string },
): Promise<string | null> {
  const virtualMcp = await ctx.storage.virtualMcps.findById(args.agentId);
  if (!virtualMcp) return null;
  const agent = resolveEffectiveStudioPackVirtualMcp(virtualMcp, args.agentId);
  const branch = await resolveSandboxBranchForThread(ctx, {
    threadId: args.threadId,
    agentRepo: (agent.metadata as { repository?: RepositoryBinding | null })
      ?.repository,
    runBranch: args.runBranch,
  });
  const record = await findRecordedSandbox(
    { virtualMcpId: agent.id, branch },
    ctx,
  );
  return record?.sandboxHandle ?? null;
}

export type LiveDeliveryOutcome =
  /** The running turn took it; do not queue. */
  | "delivered"
  /** Not delivered, but the user row is written; queue without writing it again. */
  | "queue-persisted"
  /** Not attempted; the caller's normal path does everything. */
  | "not-attempted";

/**
 * Try to deliver `message` into the thread's running claude-code turn.
 *
 * Only the thread's creator can: a teammate's message to someone else's run
 * goes through the queue, as it does today. A message already persisted is
 * retried into the run recorded on it, never into a later one, and one
 * persisted without a run was queued before, so it stays queued.
 */
export async function deliverLiveMessage<M extends LiveMessage>(args: {
  ctx: StudioContext;
  organizationId: string;
  thread: Thread;
  harnessId: string | null;
  userId: string;
  agentId: string;
  runBranch: string;
  message: M;
  /** The stored row's `liveRunId`, `null` for a stored row without one, `undefined` when not stored. */
  storedLiveRunId: string | null | undefined;
  persist: (message: M) => Promise<void>;
}): Promise<{ outcome: LiveDeliveryOutcome; message: M }> {
  const { ctx, thread, message } = args;
  const skip = { outcome: "not-attempted" as const, message };
  const text = liveMessageText(
    message as Parameters<typeof liveMessageText>[0],
  );
  if (
    text === null ||
    thread.organization_id !== args.organizationId ||
    args.harnessId !== "claude-code" ||
    thread.status !== "in_progress" ||
    thread.created_by !== args.userId ||
    args.storedLiveRunId === null ||
    !(await liveMessagesEnabled(ctx, args.organizationId))
  ) {
    return skip;
  }
  let runId = args.storedLiveRunId;
  if (runId === undefined) {
    const fence = await ctx.storage.threads.getRunFence(thread.id);
    if (!fence) return skip;
    runId = daemonRunId(thread.id, fence);
  }

  // Written before the post, so a retry that finds it knows which run to ask.
  const live = withLiveRunId(message, runId);
  await args.persist(live);
  const delivered = await (async () => {
    try {
      const handle = await liveRunSandbox(ctx, {
        threadId: thread.id,
        agentId: args.agentId,
        runBranch: args.runBranch,
      });
      if (!handle) return false;
      const provider = await getAgentSandboxProvider(ctx);
      return await postDaemonLiveMessage(provider, handle, runId, {
        id: message.id,
        text,
      });
    } catch (err) {
      console.warn("[live-messages] delivery failed", {
        threadId: thread.id,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  })();
  if (delivered) return { outcome: "delivered", message: live };
  const queued = withLiveRunId(message, null);
  await args.persist(queued);
  return { outcome: "queue-persisted", message: queued };
}
