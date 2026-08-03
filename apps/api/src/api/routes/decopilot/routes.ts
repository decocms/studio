/**
 * Decopilot Routes
 *
 * HTTP handlers for the Decopilot AI assistant.
 * Uses Memory and ModelProvider abstractions.
 */

import { createHash } from "node:crypto";
import type { StudioContext } from "@/core/studio-context";
import {
  TierUnavailableError,
  resolveTier,
  tryResolveTier,
} from "@/core/resolve-tier";
import type { SimpleModeTier } from "@decocms/shared/organization/schema";
import { posthog } from "@/posthog";
import { consumeStream, createUIMessageStreamResponse } from "ai";
import type { Context } from "hono";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_WINDOW_SIZE } from "./constants";
import { splitRequestMessages } from "./conversation";
import {
  ensureOrganization,
  isUnsafeThreadId,
  validateThreadAccess,
  validateThreadOwnership,
} from "./helpers";
import type { CancelBroadcast } from "./cancel-broadcast";
import type { StreamBuffer } from "./stream-buffer";
import type { RunRegistry } from "./run-registry";
import {
  checkModelPermission,
  fetchModelPermissions,
  filterToolTiersByPermission,
  parseModelsToMap,
} from "./model-permissions";
import { StreamRequestSchema } from "./schemas";
import type { ChatMessage, ModelsConfig } from "./types";
import type { DispatchRunInput } from "./dispatch-run";
import { buildDurableDispatchInput } from "./dispatch-run";
import { stringifyError } from "@/harnesses/lib/stream-error";
import { cancelHostedHarness, enqueueThreadRun } from "@/dispatch-queue";
import { publishRunStatusStage } from "./run-status-stage";
import { wrapWithSseKeepalive } from "./sse-keepalive";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { HarnessId } from "@/harnesses";
import { isRetiredLinkedDecopilotRuntime } from "@/harnesses/decopilot/hosted-runtime";
import type { Thread } from "@/storage/types";
import { cancelThreadBackgroundJobs } from "@/harnesses/decopilot/background-tool-workflow";
import { abortBackgroundJobs } from "@/harnesses/decopilot/background-abort-registry";
import { broadcastFlip } from "./flip-broadcast";
import { PartEmitter } from "./part-emitter";
import { uploadFileParts } from "./file-materializer";
import {
  cancelThreadGateHead,
  cancelThreadGateWorkflow,
  listThreadGateQueue,
} from "@/dispatch-queue/thread-gate-queue";
import { type QueuePartRow, foldQueueHydration } from "./queue-text";
import {
  ThreadAuthorityError,
  resolveThreadAuthority,
} from "@/core/thread-authority";

// Per-connection /stream tail diagnostics. Flip to "1" in an environment where
// the live stream intermittently delivers no chunks — logs the resolved
// deliverPolicy, run age, and the delivered chunk count per connection so a
// "policy=new + 0 chunks delivered, message still persisted" case (the
// deliverPolicy / cross-run replay race) is visible. The null-tail (204) case
// is logged unconditionally below since it always means a degraded buffer.
const STREAM_TAIL_TRACE = process.env.DECOPILOT_STREAM_TRACE === "1";

// ============================================================================
// Canonical serialization helper
// ============================================================================

/**
 * Deterministic JSON serialization with sorted object keys. Arrays keep
 * their original order; primitives are passed through as-is.
 *
 * Used by computeIdempotencyKey so that a re-serialized assistant
 * continuation message (approval / tool-output round) always hashes to the
 * same value regardless of the order in which JS inserted object keys at
 * runtime.
 */
function canonicalStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalStringify).join(",")}]`;
  const keys = Object.keys(v as object).sort();
  const pairs = keys.map(
    (k) =>
      `${JSON.stringify(k)}:${canonicalStringify((v as Record<string, unknown>)[k])}`,
  );
  return `{${pairs.join(",")}}`;
}

// ============================================================================
// Idempotency
// ============================================================================

/**
 * Derive the workflowID idempotency key from the last request message.
 *
 * - User messages have a fresh id per turn, so the id itself is unique.
 * - Assistant messages are re-POSTed with the same id across approval /
 *   tool-output rounds in a single logical turn. Hashing the serialized
 *   message makes each round produce a distinct key while still letting
 *   a genuine network retry of an identical POST collapse onto the same
 *   workflow.
 */
export function computeIdempotencyKey(
  lastMsg: ChatMessage | undefined,
): string | undefined {
  if (!lastMsg) return undefined;
  if (lastMsg.role === "user" && lastMsg.id) return lastMsg.id;
  return createHash("sha1").update(canonicalStringify(lastMsg)).digest("hex");
}

export function shouldPersistRequestMessage(input: {
  alreadyPersisted: boolean;
  role: ChatMessage["role"];
}): boolean {
  if (!input.alreadyPersisted) return true;
  return input.role === "assistant";
}

// ============================================================================
// Request Validation
// ============================================================================

async function validateRequest(
  c: Context<{ Variables: { studioContext: StudioContext } }>,
) {
  const organization = ensureOrganization(c);
  const rawPayload = await c.req.json();

  const parseResult = StreamRequestSchema.safeParse(rawPayload);
  if (!parseResult.success) {
    throw new HTTPException(400, { message: parseResult.error.message });
  }

  const { messages: rawMessages, ...rest } = parseResult.data;
  const msgs = rawMessages as unknown as ChatMessage[];
  const { systemMessages, requestMessage } = splitRequestMessages(msgs);

  return {
    organization,
    systemMessages,
    requestMessage,
    ...rest,
  };
}

function resolveHttpThreadAuthority(
  thread: Pick<Thread, "organization_id" | "created_by" | "virtual_mcp_id">,
  expected: {
    organizationId: string;
    userId: string;
  },
): { agentId: string } {
  try {
    return resolveThreadAuthority(thread, expected);
  } catch (error) {
    if (!(error instanceof ThreadAuthorityError)) throw error;
    if (error.reason === "organization_mismatch") {
      throw new HTTPException(404, { message: "Thread not found" });
    }
    if (error.reason === "owner_mismatch") {
      throw new HTTPException(403, { message: "Not authorized" });
    }
    throw new HTTPException(409, { message: error.message });
  }
}

/**
 * Resolve the hosted agent from the thread row and prove that it belongs to
 * the path-resolved organization. Request payloads never select the executing
 * Virtual MCP.
 */
async function requireHostedThreadAgent(
  ctx: StudioContext,
  thread: Pick<Thread, "organization_id" | "created_by" | "virtual_mcp_id">,
  expected: {
    organizationId: string;
    userId: string;
  },
): Promise<string> {
  const { agentId } = resolveHttpThreadAuthority(thread, expected);
  const virtualMcp = await ctx.storage.virtualMcps.findById(
    agentId,
    expected.organizationId,
  );
  if (!virtualMcp || virtualMcp.organization_id !== expected.organizationId) {
    throw new HTTPException(409, {
      message: "Thread agent is unavailable in this organization",
    });
  }
  return agentId;
}

// ============================================================================
// Per-Request Model Resolution
// ============================================================================

function toModelInfo(resolved: Awaited<ReturnType<typeof resolveTier>>) {
  const caps = resolved.modelMeta.capabilities;
  return {
    id: resolved.modelId,
    title: resolved.modelMeta.title ?? resolved.modelId,
    provider: resolved.modelMeta.providerId ?? null,
    capabilities:
      caps && caps.length > 0
        ? {
            vision:
              caps.includes("vision") || caps.includes("image") || undefined,
            text: caps.includes("text") || undefined,
            reasoning: caps.includes("reasoning") || undefined,
          }
        : undefined,
    limits: resolved.modelMeta.limits
      ? {
          contextWindow: resolved.modelMeta.limits.contextWindow,
          maxOutputTokens:
            resolved.modelMeta.limits.maxOutputTokens ?? undefined,
        }
      : undefined,
  };
}

/**
 * Resolves a tier (defaulting to "smart") to a full ModelsConfig via the
 * shared resolveTier(), which falls back to curated provider defaults when
 * the org's tier slot is unset. Also resolves the "image" and "web_research"
 * tiers — when present they enable the generate_image and web_search
 * built-in tools (registration is conditional in built-in-tools/index.ts).
 *
 * Exported so server-initiated dispatch paths (e.g. preset-task /start)
 * can compose a ModelsConfig the same way HTTP chat does, instead of
 * duplicating the tier-resolution + tryResolve fallback logic.
 */
async function resolvePerRequestModels(
  ctx: StudioContext,
  tier: SimpleModeTier | undefined,
): Promise<ModelsConfig> {
  const [chat, image, webSearch, deepResearch] = await Promise.all([
    // The only opt-in site for per-user chat-tier overrides: this is the
    // interactive chat request, dispatched as the caller themselves.
    resolveTier(ctx, tier ?? "smart", { applyUserPrefs: true }),
    tryResolveTier(ctx, "image"),
    tryResolveTier(ctx, "web_search"),
    tryResolveTier(ctx, "deep_research"),
  ]);
  return {
    credentialId: chat.credentialId,
    thinking: toModelInfo(chat),
    ...(image
      ? { image: { ...toModelInfo(image), credentialId: image.credentialId } }
      : {}),
    ...(webSearch
      ? {
          webSearch: {
            ...toModelInfo(webSearch),
            credentialId: webSearch.credentialId,
          },
        }
      : {}),
    ...(deepResearch
      ? {
          deepResearch: {
            ...toModelInfo(deepResearch),
            credentialId: deepResearch.credentialId,
          },
        }
      : {}),
  };
}

// ============================================================================
// Shared validate path
// ============================================================================

/**
 * Resolve the effective (harnessId, sandboxProviderKind, branch) for a
 * dispatch, given the values the client supplied and the (possibly
 * locked) thread row.
 *
 * Once a thread row carries a non-null `harness_id`, persisted runtime state
 * wins and any client-provided override is silently dropped. Trusted runtime
 * tools may still evolve server-owned state such as the repository branch. If the row is unlocked
 * (`harness_id == null`) or there's no thread at all (first message of
 * a freshly-created thread, or `taskIdInput === undefined`) we fall
 * back to the client values.
 *
 * Exported so the guard can be unit-tested without standing up the rest
 * of `validate()` (model resolution, permission checks, Hono context).
 *
 * See spec:
 * docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
 */
export function applyThreadLock(args: {
  taskIdInput: string | undefined;
  thread: Pick<
    Thread,
    "harness_id" | "sandbox_provider_kind" | "branch"
  > | null;
  requestedHarnessId: HarnessId | null | undefined;
  requestedSandboxProviderKind: SandboxProviderKind | null | undefined;
  requestedBranch: string | null | undefined;
}): {
  harnessId: HarnessId | null | undefined;
  sandboxProviderKind: SandboxProviderKind | null | undefined;
  branch: string | null | undefined;
  locked: boolean;
} {
  const {
    taskIdInput,
    thread,
    requestedHarnessId,
    requestedSandboxProviderKind,
    requestedBranch,
  } = args;

  if (!taskIdInput || !thread?.harness_id) {
    return {
      harnessId: requestedHarnessId,
      sandboxProviderKind: requestedSandboxProviderKind,
      // Prefer the thread's own branch even while the thread is still
      // unlocked (harness_id null = this is the first message). The branch is
      // assigned at COLLECTION_THREADS_CREATE time, so it exists before the
      // harness/sandbox lock is written. Falling back to `requestedBranch`
      // here would make the first turn use the synthetic "ephemeral" sandbox
      // while continuations use the thread's real branch. This matches the
      // pin-write resolution in the POST handler
      // (`existingThread?.branch ?? …`).
      //
      // Only consult the thread row when there is a real `taskIdInput`;
      // legacy callers with no thread id must ignore the row entirely (the
      // `!taskIdInput` half of the guard above), same as harness/sandbox.
      branch: taskIdInput
        ? (thread?.branch ?? requestedBranch)
        : requestedBranch,
      locked: false,
    };
  }

  if (requestedHarnessId && requestedHarnessId !== thread.harness_id) {
    console.warn(
      "decopilot.submit: ignored harness override on locked thread",
      {
        threadId: taskIdInput,
        requested: requestedHarnessId,
        locked: thread.harness_id,
      },
    );
  }

  return {
    harnessId: thread.harness_id as HarnessId,
    sandboxProviderKind:
      (thread.sandbox_provider_kind as SandboxProviderKind | null) ?? undefined,
    branch: thread.branch ?? null,
    locked: true,
  };
}

/**
 * The hosted messages endpoint is Decopilot-only. Native coding-agent ids can
 * remain on persisted thread rows so the desktop app can resume them, but the
 * cloud route must reject those rows before model resolution or any write.
 */
export function assertHostedDecopilotHarness(
  harnessId: string | null | undefined,
): asserts harnessId is "decopilot" | null | undefined {
  if (
    harnessId !== null &&
    harnessId !== undefined &&
    harnessId !== "decopilot"
  ) {
    throw new HTTPException(409, {
      message: "This coding-agent chat can only run in the Studio desktop app",
    });
  }
}

export function assertHostedSandboxProvider(
  sandboxProviderKind: string | null | undefined,
): asserts sandboxProviderKind is "agent-sandbox" | null | undefined {
  if (
    sandboxProviderKind !== null &&
    sandboxProviderKind !== undefined &&
    sandboxProviderKind !== "agent-sandbox"
  ) {
    throw new HTTPException(409, {
      message: "This chat is pinned to an unsupported desktop runtime",
    });
  }
}

function assertHostedRuntime(
  harnessId: string | null | undefined,
  sandboxProviderKind: string | null | undefined,
): void {
  normalizeHostedSandboxProviderKind(harnessId, sandboxProviderKind);
}

/**
 * `decopilot + user-desktop` is a readable legacy tuple from the retired link
 * runtime. It now executes as hosted Decopilot, while every coding-agent
 * harness remains native-only.
 */
export function normalizeHostedSandboxProviderKind(
  harnessId: string | null | undefined,
  sandboxProviderKind: string | null | undefined,
): "agent-sandbox" | null | undefined {
  assertHostedDecopilotHarness(harnessId);
  if (isRetiredLinkedDecopilotRuntime({ harnessId, sandboxProviderKind })) {
    return "agent-sandbox";
  }
  assertHostedSandboxProvider(sandboxProviderKind);
  return sandboxProviderKind;
}

/**
 * Mutating control routes operate only on a thread that has already been
 * claimed by hosted Decopilot. Unlike the message and stream routes, they do
 * not need to support an unpinned thread: accepting one would leave a race in
 * which native startup could claim the row after validation but before the
 * hosted mutation landed.
 */
export function assertPersistedHostedRuntime(
  harnessId: string | null | undefined,
  sandboxProviderKind: string | null | undefined,
): asserts harnessId is "decopilot" {
  assertHostedRuntime(harnessId, sandboxProviderKind);
  if (harnessId !== "decopilot") {
    throw new HTTPException(409, {
      message: "This chat has not started a hosted run",
    });
  }
}

/**
 * Parse + permission-check an HTTP request into a `DispatchRunInput`
 * ready to hand to `enqueueThreadRun` (POST /messages).
 *
 * Pure-ish: reads `c` for the request body and auth context, but no
 * downstream side effects. Throws `HTTPException` / `TierUnavailableError`
 * for caller-visible problems.
 *
 * When `threadIdParam` is provided (e.g. from a URL path like
 * `/threads/:threadId/...`) the body's `thread_id` must match — rejecting
 * a body that disagrees rather than silently overriding either side.
 * Legacy callers that supply the id in the body alone are unaffected.
 */
async function validate(
  c: Context<{ Variables: { studioContext: StudioContext } }>,
  threadIdParam: string | undefined,
): Promise<DispatchRunInput> {
  const ctx = c.get("studioContext");

  const {
    organization,
    tier,
    systemMessages,
    requestMessage,
    temperature,
    memory: memoryConfig,
    thread_id,
    branch,
    toolApprovalLevel,
    mode,
  } = await validateRequest(c);

  const bodyThreadId = thread_id ?? memoryConfig?.thread_id;
  if (threadIdParam && bodyThreadId && bodyThreadId !== threadIdParam) {
    throw new HTTPException(400, {
      message: "threadId in URL does not match thread_id in body",
    });
  }
  const taskIdInput = threadIdParam ?? bodyThreadId;
  if (taskIdInput && isUnsafeThreadId(taskIdInput)) {
    throw new HTTPException(400, { message: "Invalid thread ID" });
  }

  const userId = ctx.auth?.user?.id;
  if (!userId) {
    throw new HTTPException(401, { message: "User ID is required" });
  }

  // Resolve authority before model selection or any message/runtime write.
  // The thread row owns both the user and Virtual MCP identities. Legacy
  // request selectors were stripped by StreamRequestSchema and cannot affect
  // execution.
  if (!taskIdInput) {
    throw new HTTPException(400, { message: "threadId is required" });
  }
  const lockedThread = await ctx.storage.threads.get(taskIdInput);
  if (!lockedThread) {
    throw new HTTPException(404, { message: "Thread not found" });
  }
  await requireHostedThreadAgent(ctx, lockedThread, {
    organizationId: organization.id,
    userId,
  });

  // Lock guard: once a thread row carries a non-null `harness_id`, the
  // thread's persisted runtime (harness, sandbox provider, branch) wins over
  // client-provided overrides. Trusted runtime tools may still evolve
  // server-owned state such as the repository branch. Native harnesses
  // are then rejected before model resolution or any message/pin write.
  //
  // See spec:
  // docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
  const {
    harnessId: effectiveHarnessId,
    sandboxProviderKind: effectiveSandboxProviderKind,
    branch: effectiveBranch,
  } = applyThreadLock({
    taskIdInput,
    thread: lockedThread,
    requestedHarnessId: "decopilot",
    requestedSandboxProviderKind: "agent-sandbox",
    requestedBranch: branch,
  });
  assertHostedRuntime(effectiveHarnessId, effectiveSandboxProviderKind);

  const resolvedModels = await resolvePerRequestModels(ctx, tier);

  const allowedModels = await fetchModelPermissions(
    ctx.db,
    organization.id,
    // `organization.role` is the path-resolved role (set by resolveOrgFromPath);
    // ctx.auth.user?.role is the session's active-org role and may belong to a
    // different org than `organization` if the caller's active org differs.
    organization.role ?? ctx.auth.user?.role,
  );
  if (
    allowedModels !== undefined &&
    !checkModelPermission(
      allowedModels,
      resolvedModels.credentialId,
      resolvedModels.thinking.id,
    )
  ) {
    throw new HTTPException(403, {
      message: "Model not allowed for your role",
    });
  }
  // Silently drop tool tiers (image, deepResearch) that resolve to a key
  // the user's role can't access — otherwise an admin-set tier slot would
  // grant restricted users implicit access to the underlying credential
  // via generate_image / web_search.
  const models = filterToolTiersByPermission(allowedModels, resolvedModels);

  return {
    messages: [...systemMessages, requestMessage],
    models,
    temperature,
    toolApprovalLevel,
    mode,
    organizationId: organization.id,
    userId,
    taskId: taskIdInput,
    windowSize: memoryConfig?.windowSize ?? DEFAULT_WINDOW_SIZE,
    branch: effectiveBranch ?? null,
  };
}

// ============================================================================
// Route Handler
// ============================================================================

export interface DecopilotDeps {
  cancelBroadcast: CancelBroadcast;
  streamBuffer: StreamBuffer;
  runRegistry: RunRegistry;
}

export function createDecopilotRoutes(deps: DecopilotDeps) {
  const { cancelBroadcast, streamBuffer, runRegistry } = deps;
  const app = new Hono<{ Variables: { studioContext: StudioContext } }>();

  // ============================================================================
  // Allowed Models Endpoint
  // ============================================================================

  app.get("/:org/decopilot/allowed-models", async (c) => {
    try {
      const ctx = c.get("studioContext");
      const organization = ensureOrganization(c);
      // `organization.role` is the path-resolved role (set by resolveOrgFromPath);
      // ctx.auth.user?.role is the session's active-org role and may belong to a
      // different org than `organization` if the caller's active org differs.
      const role = organization.role ?? ctx.auth.user?.role;

      const models = await fetchModelPermissions(ctx.db, organization.id, role);

      return c.json(parseModelsToMap(models));
    } catch (err) {
      console.error("[decopilot:allowed-models] Error", err);
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      return c.json(
        { error: err instanceof Error ? err.message : "Internal error" },
        500,
      );
    }
  });

  // ============================================================================
  // Messages Endpoint — enqueue a run on the per-thread gate queue
  // ============================================================================
  //
  // POST /:org/decopilot/threads/:threadId/messages
  //
  // Enqueues the run on `threadGateWorkflow` (partition=threadId,
  // concurrency=1) and returns `202 { taskId }` in milliseconds. The
  // response carries no SSE body — the client is expected to be listening
  // on `GET /:org/decopilot/threads/:threadId/stream` to receive chunks once the
  // workflow dequeues and dispatches.
  //
  // If another run on this thread is already executing, the new message
  // queues behind it and dispatches only after that run completes.
  //
  // Idempotency: a retried POST collapses onto the existing workflow
  // handle. The key is derived from the last message:
  //   - user turn: the message id (unique per turn).
  //   - approval / tool-output continuation: SHA1 of the serialized
  //     message. The assistant message id is reused across approval
  //     rounds in the same logical turn, so the id alone would dedupe
  //     two distinct accepts onto the first workflow and leave the
  //     second round's state unsaved (bricked approval prompt). Hashing
  //     the message contents gives each round a fresh workflowID while
  //     still collapsing genuine network retries of the same POST.

  app.post("/:org/decopilot/threads/:threadId/messages", async (c) => {
    try {
      const ctx = c.get("studioContext");
      const input = await validate(c, c.req.param("threadId"));
      const taskId = input.taskId;
      if (!taskId) {
        // validate() always sets taskId from the URL param, so this is
        // a structural invariant rather than a user-facing error.
        throw new HTTPException(400, { message: "threadId is required" });
      }

      // Re-read the canonical row for its pin, agent, and message-storage
      // version. A storage error must fail closed so a disappearing row cannot
      // enqueue hosted work.
      const existingThread = await ctx.storage.threads.get(taskId);
      if (!existingThread) {
        throw new HTTPException(404, { message: "Thread not found" });
      }
      const authoritativeAgentId = await requireHostedThreadAgent(
        ctx,
        existingThread,
        {
          organizationId: input.organizationId,
          userId: input.userId,
        },
      );

      // Fall back to the "ephemeral" synthetic branch when neither the
      // thread row nor the request body pins one. Synthetic branches
      // (see packages/sandbox/daemon-go/internal/gitx/refname.go:isSyntheticBranch) are
      // accepted by the daemon as sandboxMap routing keys but never checked
      // out — exactly the right semantics for Decopilot threads on
      // agents with no clonable repo, where the branch is purely an
      // isolation key.
      let branch = existingThread.branch ?? input.branch ?? "ephemeral";

      // Determine the pinned (kind, harness). If the thread row has them,
      // use those. Otherwise this is the first message — derive defaults and
      // persist to the thread row.
      let pinnedKind = (existingThread.sandbox_provider_kind ??
        null) as SandboxProviderKind | null;

      let pinnedHarness = (existingThread.harness_id ??
        null) as HarnessId | null;
      let messageStorageVersion = existingThread.message_storage_version;

      // The row may have changed between validate() and this canonical re-read.
      // Re-assert before the initial-pin branch so a persisted non-hosted
      // runtime cannot be mutated by this route before it returns 409.
      pinnedKind =
        normalizeHostedSandboxProviderKind(pinnedHarness, pinnedKind) ?? null;

      // A non-null harness is the runtime lock. Legacy Decopilot rows may have
      // either a null or retired user-desktop sandbox kind; both execute as the
      // hosted agent sandbox without rewriting the historical row.
      if (!pinnedHarness) {
        pinnedKind = pinnedKind ?? "agent-sandbox";
        pinnedHarness = "decopilot";
        assertHostedRuntime(pinnedHarness, pinnedKind);

        // Stream-of-record v2 is the ONLY write path (Phase C cutover). Pin
        // every NEW thread (no prior messages, not already v2) to v2 so the
        // ingest → JetStream → durable-projector pipeline persists its parts.
        // Pre-existing v1 threads WITH history stay v1: deprecated read-only
        // legacy — their `thread_messages` rows still render via the v1 read
        // path; no backfill. The message-count probe only runs for not-yet-v2
        // threads, so already-v2 threads add no DB read.
        let pinV2 = false;
        if (existingThread.message_storage_version !== 2) {
          try {
            const { total } = await ctx.storage.threads.listMessages(taskId, {
              limit: 1,
            });
            pinV2 = total === 0;
          } catch {
            pinV2 = false;
          }
        }
        // Claim all runtime pins in one CAS. A native start can race this
        // request, so an unconditional update would let the hosted path
        // overwrite a runtime that became native after our preceding read.
        const claimed = await ctx.storage.threads.pinRuntimeIfUnset(taskId, {
          harnessId: pinnedHarness,
          sandboxProviderKind: pinnedKind,
          branch,
          ...(pinV2 ? { messageStorageVersion: 2 } : {}),
        });
        if (!claimed.thread) {
          throw new HTTPException(404, { message: "Thread not found" });
        }
        pinnedHarness = claimed.thread.harness_id as HarnessId | null;
        pinnedKind = claimed.thread
          .sandbox_provider_kind as SandboxProviderKind | null;
        branch = claimed.thread.branch ?? "ephemeral";
        messageStorageVersion = claimed.thread.message_storage_version;
        if (claimed.thread.virtual_mcp_id !== authoritativeAgentId) {
          await requireHostedThreadAgent(ctx, claimed.thread, {
            organizationId: input.organizationId,
            userId: input.userId,
          });
        }
      }
      pinnedKind =
        normalizeHostedSandboxProviderKind(pinnedHarness, pinnedKind) ?? null;

      if (messageStorageVersion !== 2) {
        throw new HTTPException(409, {
          message:
            "Thread uses legacy message storage and cannot accept new messages",
        });
      }

      const requestMessage = input.messages.find((m) => m.role !== "system");
      if (!requestMessage) {
        throw new HTTPException(400, {
          message: "No user message found in input",
        });
      }
      const materializedRequestMessage = (
        await uploadFileParts([requestMessage], ctx, {
          threadId: taskId,
        })
      ).find((m) => m.role !== "system");
      if (!materializedRequestMessage) {
        throw new HTTPException(400, {
          message: "No user message found after file materialization",
        });
      }
      const messageId = materializedRequestMessage.id ?? crypto.randomUUID();
      const persistedRequestMessage = {
        ...materializedRequestMessage,
        id: messageId,
      };
      const alreadyPersisted = Boolean(
        await ctx.db
          .selectFrom("thread_message_parts")
          .select("id")
          .where("thread_id", "=", taskId)
          .where("message_id", "=", messageId)
          .executeTakeFirst(),
      );
      // Idempotency: the gate workflow id is keyed by the turn's idempotency
      // key (user message id, or SHA1 for continuations), so a network
      // redelivery collapses onto the existing workflow. The run FENCE is NOT
      // minted here: `claimRunFenceForDispatch` mints + persists it inside the
      // gate's dispatch step, i.e. only while holding the thread's partition
      // slot — so queueing a message behind a running turn can never clobber
      // the running turn's fence (which stranded its projection).
      const idempotencyKey = computeIdempotencyKey(persistedRequestMessage);
      const workflowID = idempotencyKey
        ? `thread-run:${taskId}:${idempotencyKey}`
        : undefined;

      const emitter = new PartEmitter({
        storage: ctx.storage.threads.messageParts(),
        orgId: input.organizationId,
        threadId: taskId,
        runId: taskId,
      });
      if (
        shouldPersistRequestMessage({
          alreadyPersisted,
          role: persistedRequestMessage.role,
        })
      ) {
        await emitter.emitRequestMessage(persistedRequestMessage);
      }

      const serializableRequest = buildDurableDispatchInput(input, {
        messageId,
        branch,
      });
      // The workflow body emits `chat_message_started` inside a DBOS step,
      // so idempotent retries that collapse onto an existing workflowID
      // don't double-count in PostHog. Don't add a duplicate emit here.
      if (existingThread.status !== "in_progress") {
        await publishRunStatusStage(streamBuffer, taskId, "waiting-runner");
      }
      await enqueueThreadRun(
        {
          threadId: taskId,
          request: serializableRequest,
          source: "user-message",
        },
        { workflowID },
      );
      return c.json({ taskId }, 202);
    } catch (err) {
      console.error("[decopilot:messages] Error", err);
      if (err instanceof TierUnavailableError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof HTTPException) {
        return c.json({ error: err.message }, err.status);
      }
      posthog.captureException(err);
      return c.json(
        { error: err instanceof Error ? err.message : JSON.stringify(err) },
        500,
      );
    }
  });

  // ============================================================================
  // Cancel Endpoint — cancel a hosted run locally or via NATS to its owning pod
  // ============================================================================

  // Shared run-cancel teardown: durable cancel flag, background-job teardown,
  // hosted-child cancel, in-pod abort + cross-pod NATS broadcast, local turn
  // cancel, gate-head cancel, ghost force-fail. Used by the stop endpoint and
  // the per-item queue cancel (running head).
  async function cancelActiveThreadRun(args: {
    ctx: StudioContext;
    taskId: string;
    thread: Thread;
    organization: { id: string };
    userId: string;
  }): Promise<void> {
    const { ctx, taskId, thread, organization, userId } = args;
    assertPersistedHostedRuntime(
      thread.harness_id,
      thread.sandbox_provider_kind,
    );

    // Persist durable cancel flag so the ingest backstop rejects 409.
    await ctx.storage.threads.setCancelRequested(taskId, organization.id);

    // Tear down any background-tool workflows this thread started (image gen /
    // backgrounded subtasks). They run on their own DBOS queue, so the
    // in-memory run cancel below doesn't reach them. Non-fatal: a DBOS hiccup
    // must not block the user-facing cancel.
    await cancelThreadBackgroundJobs(taskId).catch((err) => {
      console.error("[decopilot:cancel] failed to cancel background jobs", {
        taskId,
        err,
      });
    });

    // Free a stranded/stuck PENDING gate head so the partition slot releases
    // and the queue can proceed (an orphaned/zombie gate has no in-memory run
    // for the CANCEL command to abort — cancelling the DBOS workflow row is
    // the only thing that frees the concurrency=1 partition).
    await cancelThreadGateHead(taskId).catch((err) => {
      console.error("[decopilot:cancel] failed to cancel gate head", {
        taskId,
        err,
      });
    });

    // Tear down the hosted-harness child workflow (Task 7b / unified-control-
    // plane T7). Division of labor vs. the in-memory cancel below
    // (cancelBroadcast + run-registry CANCEL → AbortController):
    //   - RUNNING child (already dequeued, `runHostedHarness` step executing):
    //     `DBOS.cancelWorkflow` (called by `cancelHostedHarness`) is a pure DB
    //     status flip to CANCELLED — DBOS only checks that flag BEFORE a step
    //     starts / when recording a step's result, never mid-step (verified
    //     against @dbos-inc/dbos-sdk 4.21.6's `callStepFunction` — no
    //     AbortSignal is threaded into an in-flight non-timeout step call). So
    //     for an already-running child this call does NOT stop the agent loop
    //     in real time; the run-registry's `abortController.abort()` below
    //     (wired into the harness kernel call via `registrySignal` in
    //     dispatch-run.ts) is what actually interrupts it. What this call DOES
    //     guarantee for a running child: it can never later report SUCCESS,
    //     and — because the child has `maxRecoveryAttempts: 1000` for
    //     multi-hour survivability — a pod crash right after Stop can't have
    //     DBOS's recovery executor resurrect/re-run it on a new pod.
    //   - ENQUEUED child (started but not yet dequeued by the concurrency=1
    //     hosted-harness queue partition — no in-memory run/AbortController
    //     exists yet for the registry cancel to reach): this call flips it
    //     straight to CANCELLED and clears its queue slot, so it is NEVER
    //     dequeued/executed — a full, real cancel for that narrow window.
    // Keyed by `decopilot-hosted:<runId>:<fenceToken>` (`hostedChildWorkflowId`,
    // the same single source of truth `startHostedHarness` uses) — read the
    // current fence from the thread row. Best-effort: cancelling an
    // already-finished/unknown workflow must not fail the cancel.
    // The fence current when this cancel was issued — identifies the exact turn
    // being stopped. Reused below to scope the ghost force-fail so it can't
    // clobber a follow-up turn (fresh fence) that starts while this cancel is
    // still settling.
    let cancelFenceToken: string | null = null;
    try {
      cancelFenceToken = await ctx.storage.threads.getRunFence(taskId);
      if (cancelFenceToken) {
        await cancelHostedHarness(taskId, cancelFenceToken);
      }
    } catch (err) {
      console.error("[decopilot:cancel] failed to cancel hosted harness", {
        taskId,
        err,
      });
    }

    // Abort in-flight background work on this pod now, and fan the cancel out
    // to every pod over NATS. Always broadcast: a background job runs on
    // whichever pod DBOS dequeued it, so a locally-owned turn no longer implies
    // no other pod is involved. Each pod's onCancel aborts its background
    // controllers (`abortBackgroundJobs`) and cancels the live turn if it owns
    // it; both are no-ops where they don't apply.
    abortBackgroundJobs(taskId);
    cancelBroadcast.broadcast(taskId);

    // Try to cancel the live turn locally for an immediate response.
    const cancelTransitions = await runRegistry.execute({
      type: "CANCEL",
      taskId,
    });
    cancelBroadcast.publishControlFrame(userId, {
      type: "cancel",
      runId: taskId,
    });
    const producedRunFailed = cancelTransitions.some(
      (t) => t.event.type === "RUN_FAILED",
    );

    // Ghost run: server restarted while a run was in progress. No pod has this
    // run in memory, so the broadcast will never resolve. Force-fail the thread
    // in the DB so the user can send new messages.
    if (!producedRunFailed && thread.status === "in_progress") {
      console.warn("[decopilot:cancel] Ghost run detected, force-failing", {
        taskId,
      });
      runRegistry
        .execute({
          type: "FORCE_FAIL",
          taskId,
          reason: "ghost",
          orgId: organization.id,
          // Scope to the turn being cancelled. This teardown is fire-and-forget
          // (the cancel returns 202 immediately) and, in a multi-pod cluster,
          // usually runs on a pod that does NOT own the run — so a follow-up
          // turn sent right after "stop" can start (fresh fence, thread back to
          // `in_progress`) BEFORE this force-fail lands. Without the fence guard
          // the stale snapshot would flip that follow-up to `failed`, and the
          // user's next message "never returns".
          expectedFenceToken: cancelFenceToken,
        })
        .catch((err) => {
          console.error(
            "[decopilot:cancel] Failed to force-fail ghost thread",
            {
              taskId,
              err,
            },
          );
        });
    }
  }

  app.post("/:org/decopilot/cancel/:threadId", async (c) => {
    const { ctx, taskId, thread, organization, userId } =
      await validateThreadOwnership(c);
    assertPersistedHostedRuntime(
      thread.harness_id,
      thread.sandbox_provider_kind,
    );
    await cancelActiveThreadRun({ ctx, taskId, thread, organization, userId });
    return c.json({ cancelled: true, async: true }, 202);
  });

  // Flip a still-running FOREGROUND subtask to the background so the thread gate
  // frees up and the user can keep chatting. Fanned out over NATS to whichever
  // pod runs the turn (like cancel); that pod's running `subtask` call aborts
  // its inline run and re-runs it as a durable background job. Owner-only.
  app.post("/:org/decopilot/flip/:threadId", async (c) => {
    const { taskId, thread } = await validateThreadOwnership(c);
    assertPersistedHostedRuntime(
      thread.harness_id,
      thread.sandbox_provider_kind,
    );
    const body = (await c.req.json().catch(() => null)) as {
      toolCallId?: unknown;
    } | null;
    const toolCallId = body?.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      return c.json({ error: "toolCallId is required" }, 400);
    }
    broadcastFlip(taskId, toolCallId);
    return c.json({ flipped: true, async: true }, 202);
  });

  // ==========================================================================
  // Queue Endpoints — the thread's pending gate workflows (running head +
  // queued tail), surfaced so the UI can render queued bubbles and cancel
  // them. Owner-only (validateThreadOwnership).
  // ==========================================================================

  app.get("/:org/decopilot/queue/:threadId", async (c) => {
    const { ctx, taskId, thread } = await validateThreadOwnership(c);
    assertHostedRuntime(thread.harness_id, thread.sandbox_provider_kind);
    const items = await listThreadGateQueue(taskId);
    if (items.length === 0) return c.json({ items: [] });
    // Hydrate tray display text + attachment presence from the persisted
    // request parts (the durable gate input carries no message content).
    const rows = await ctx.db
      .selectFrom("thread_message_parts")
      .select(["message_id", "kind", "seq", "payload"])
      .where("thread_id", "=", taskId)
      .where(
        "message_id",
        "in",
        items.map((i) => i.messageId),
      )
      .execute();
    const hydration = foldQueueHydration(rows as QueuePartRow[]);
    return c.json({
      items: items.map((i) => ({
        ...i,
        text: hydration.get(i.messageId)?.text ?? "",
        hasAttachments: hydration.get(i.messageId)?.hasAttachments ?? false,
      })),
    });
  });

  app.post("/:org/decopilot/queue/:threadId/cancel/:workflowId", async (c) => {
    const { ctx, taskId, thread, organization, userId } =
      await validateThreadOwnership(c);
    assertPersistedHostedRuntime(
      thread.harness_id,
      thread.sandbox_provider_kind,
    );
    const workflowId = c.req.param("workflowId");

    // The item must currently be pending for THIS thread (prefix-scoped list).
    const items = await listThreadGateQueue(taskId);
    const target = items.find((i) => i.workflowId === workflowId);
    if (!target) return c.body(null, 404);

    const ok = await cancelThreadGateWorkflow(taskId, workflowId);
    if (!ok) return c.body(null, 404);

    if (target.status === "running") {
      // The head was already live: also run the full run-cancel teardown
      // (abort + broadcast + registry CANCEL + ghost force-fail). The
      // re-cancel of the gate head inside is an idempotent no-op.
      await cancelActiveThreadRun({
        ctx,
        taskId,
        thread,
        organization,
        userId,
      });
    } else {
      // Removed a QUEUED turn: its request message was already persisted at
      // POST time — delete the part rows so the bubble doesn't resurrect on
      // reload. Only for plain user turns; a queued approval-continuation's
      // message id points at the historical assistant proposal, which must
      // NOT be deleted. Best-effort: the workflow is already CANCELLED (an
      // irrevocable success), so a transient DB failure here must not 500 the
      // request — log it and still report the cancel as done.
      try {
        const role = await ctx.db
          .selectFrom("thread_message_parts")
          .select("role")
          .where("thread_id", "=", taskId)
          .where("message_id", "=", target.messageId)
          .limit(1)
          .executeTakeFirst();
        if (role?.role === "user") {
          await ctx.storage.threads
            .messageParts()
            .deleteMessageParts(taskId, target.messageId);
        }
      } catch (err) {
        console.error(
          "[decopilot:queue-cancel] failed to delete queued message parts",
          { taskId, messageId: target.messageId, err },
        );
      }
    }
    return c.json({ cancelled: true }, 202);
  });

  // ============================================================================
  // Stream Endpoint — tail the per-thread JetStream subject
  // ============================================================================
  //
  // Pure live tail. The client owns initial message state via the
  // `COLLECTION_THREAD_MESSAGES_LIST` MCP tool and re-fetches the latest
  // page on every reconnect; this endpoint serves only live UI message
  // chunks from the JetStream subject. The persistent connection stays
  // open across runs — clients detect run boundaries from the AI-SDK
  // `{type: "finish"}` chunk. One open stream per (tab, thread) covers
  // every run.
  //
  // Recovery for in-flight runs whose owning pod died is handled out of
  // band: the thread-gate workflow step is restarted by the DBOS recovery
  // executor on a healthy pod, and the heartbeat watcher in `app.ts`
  // resurrects orphaned runs explicitly. Either way, chunks land back on
  // this thread's JetStream subject and the existing stream tail picks
  // them up — no client-triggered resume is needed here.

  app.get("/:org/decopilot/threads/:threadId/stream", async (c) => {
    try {
      const { taskId, thread } = await validateThreadAccess(c);
      assertHostedRuntime(thread.harness_id, thread.sandbox_provider_kind);

      // Use the DB's view, not pod-local registry state. A client attached
      // to a non-owner pod (any multi-pod deployment, including mid-deploy
      // and after a DBOS replay rehome) needs `"all"` to catch chunks the
      // owning pod has already pumped to the shared JetStream subject.
      // `"all"` replays the whole per-thread subject (catch-up to the in-flight
      // run); `"new"` when the thread is idle so a just-completed run's tail
      // isn't replayed. No fence-filter — the tail forwards EVERY run's chunks
      // and the client reassembler folds them per run (a continuation's
      // tool-output reconciles against the proposal it seeds from).
      const deliverPolicy = thread.status === "in_progress" ? "all" : "new";
      const runStartedAgoMs = thread.run_started_at
        ? Date.now() - new Date(thread.run_started_at).getTime()
        : null;
      const tailChunkStream = await streamBuffer.createTailStream(
        taskId,
        c.req.raw.signal,
        { deliverPolicy },
      );
      if (!tailChunkStream) {
        // A null tail means the JetStream buffer is degraded on this pod
        // (client gets 204 → no live chunks). High-signal, always logged.
        console.warn(
          JSON.stringify({
            msg: "decopilot-stream-diag",
            event: "tail-unavailable-204",
            taskId,
            threadStatus: thread.status,
            deliverPolicy,
            runStartedAgoMs,
          }),
        );
        return c.body(null, 204);
      }

      if (STREAM_TAIL_TRACE) {
        console.warn(
          JSON.stringify({
            msg: "decopilot-stream-diag",
            event: "tail-open",
            taskId,
            threadStatus: thread.status,
            deliverPolicy,
            runStartedAgoMs,
          }),
        );
      }

      // Pure pass-through: `createTailStream` decoded the NATS log into
      // UIMessageChunks; hand them straight to the SSE serializer. The client
      // (useChat) is the only reassembler — a server-side `createUIMessageStream`
      // layer added nothing to the wire and any stateful reassembly here would
      // choke on a replayed run's chunks.
      return wrapWithSseKeepalive(
        createUIMessageStreamResponse({
          stream: tailChunkStream,
          consumeSseStream: consumeStream,
        }),
      );
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[decopilot:stream] Error", stringifyError(err));
      return c.body(null, 500);
    }
  });

  // ============================================================================
  // Subtask Stream Endpoint — tail a backgrounded subtask's per-job subject
  // ============================================================================
  //
  // A backgrounded `subtask` runs off the thread and publishes its live run to
  // `decopilot.stream.<jobId>` (NOT the thread's subject), so the subtask card's
  // panel can tail it without colliding with the thread's own single-writer
  // stream. `deliverPolicy: "all"` replays the run from its start, since the
  // panel typically opens after the subtask was kicked off. The jobId must be a
  // `bgtool:<threadId>:…` id for THIS thread — that scoping is the authz.
  app.get("/:org/decopilot/threads/:threadId/jobs/:jobId/stream", async (c) => {
    try {
      const { taskId, thread } = await validateThreadAccess(c);
      assertHostedRuntime(thread.harness_id, thread.sandbox_provider_kind);
      const jobId = c.req.param("jobId");
      if (!jobId || !jobId.startsWith(`bgtool:${taskId}:`)) {
        return c.body(null, 404);
      }

      const tailChunkStream = await streamBuffer.createTailStream(
        jobId,
        c.req.raw.signal,
        { deliverPolicy: "all" },
      );
      if (!tailChunkStream) return c.body(null, 204);

      // Pure pass-through (the subtask subject is already per-job/single-run).
      return wrapWithSseKeepalive(
        createUIMessageStreamResponse({
          stream: tailChunkStream,
          consumeSseStream: consumeStream,
        }),
      );
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[decopilot:subtask-stream] Error", stringifyError(err));
      return c.body(null, 500);
    }
  });

  return app;
}
