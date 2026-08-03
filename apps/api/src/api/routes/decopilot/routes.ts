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
import { resolveAgentTier } from "@/harnesses/lib/claude-code/model/agent-tiers";
import {
  ChatTierSchema,
  type ChatTier,
  type SimpleModeTier,
} from "@decocms/shared/organization/schema";
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
import { buildDurableDispatchInput, resolveHarnessId } from "./dispatch-run";
import { stringifyError } from "@/harnesses/lib/stream-error";
import { cancelHostedHarness, enqueueThreadRun } from "@/dispatch-queue";
import { canRespondToThread } from "@decocms/shared/thread/access";
import {
  publishRunStatusStage,
  shouldPublishClusterRunStatus,
} from "./run-status-stage";
import { wrapWithSseKeepalive } from "./sse-keepalive";
import {
  resolveSandboxProviderKindFromEnv,
  type SandboxProviderKind,
} from "@decocms/sandbox/provider";
import type { HarnessId } from "@/harnesses";
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

/**
 * Look up the providerId for the credential the request would use, so
 * POST /messages can pick the right harness (and therefore the right
 * link capability) before enqueuing onto the thread gate. Returns
 * undefined when the credential row isn't found — the caller falls back
 * to "decopilot" (matches the existing prepareRun behavior).
 */
async function resolveProviderId(
  ctx: StudioContext,
  credentialId: string,
  organizationId: string,
): Promise<string | undefined> {
  try {
    const row = await ctx.storage.aiProviderKeys.findById(
      credentialId,
      organizationId,
    );
    return row?.providerId;
  } catch {
    return undefined;
  }
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
  harnessId: HarnessId | null | undefined,
): Promise<ModelsConfig> {
  if (harnessId === "claude-code" || harnessId === "codex") {
    const chatTier: ChatTier = ChatTierSchema.safeParse(tier).data ?? "smart";
    const entry = resolveAgentTier(harnessId, chatTier);
    if (!entry) {
      // Should be unreachable — resolveAgentTier returns non-null for
      // both supported CLI harnesses and every ChatTier value.
      throw new Error(
        `No model mapping for harness "${harnessId}" tier "${chatTier}"`,
      );
    }
    return {
      credentialId: `desktop:${harnessId}`,
      thinking: {
        id: entry.modelId,
        title: entry.label,
        provider: harnessId,
        capabilities: { vision: true, text: true },
      },
    };
  }

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
 * Once a thread row carries a non-null `harness_id`, the thread's
 * runtime is pinned for life: the row's values win and any
 * client-provided override is silently dropped. If the row is unlocked
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
      // here — as we used to — meant the first turn resolved to a null branch
      // and dispatched against the synthetic "ephemeral" sandbox, while
      // continuations (by then locked) used the thread's real branch. The
      // claude-code session created on turn 1 then lived in a different
      // sandbox than the one `claude --resume` ran in on turn 2, producing
      // "No conversation found with session ID". Matches the pin-write
      // resolution in the POST handler (`existingThread?.branch ?? …`).
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
): Promise<
  DispatchRunInput & {
    sandboxProviderKind?: SandboxProviderKind | null;
    harnessId?: HarnessId | null;
  }
> {
  const ctx = c.get("studioContext");

  const {
    organization,
    tier,
    agent,
    systemMessages,
    requestMessage,
    temperature,
    memory: memoryConfig,
    thread_id,
    branch,
    toolApprovalLevel,
    mode,
    sandboxProviderKind,
    harnessId,
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

  // Lock guard: once a thread row carries a non-null `harness_id`, the
  // thread's runtime (harness, sandbox provider, branch) is pinned for
  // life. Any client-provided override is silently dropped, and the
  // per-request model resolution below uses the locked harness so we
  // never dispatch with mismatched (harness, models).
  //
  // See spec:
  // docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md
  const lockedThread = taskIdInput
    ? await ctx.storage.threads.get(taskIdInput)
    : null;

  // Thread write-authorization. Only the owner may send messages, EXCEPT while
  // the thread is paused awaiting input (`requires_action` — e.g. a QA Agent /
  // Code Reviewer `user_ask`), where any org member may answer so the run isn't
  // stuck on one person. This MUST run at ingress, before the message is
  // persisted and before the dispatch gate mints a run fence — the fence flips
  // the status to `in_progress` (see `setRunFence`), erasing the
  // `requires_action` signal this decision reads. Org membership is already
  // enforced (resolveOrgFromPath + the org-scoped `threads.get` above), so this
  // only decides ownership vs. the awaiting-input exception. A brand-new thread
  // (no `lockedThread` yet) is permissive — its first message creates it owned
  // by the sender.
  if (
    !canRespondToThread({
      createdBy: lockedThread?.created_by,
      userId,
      status: lockedThread?.status,
    })
  ) {
    throw new HTTPException(403, {
      message:
        "You are not allowed to write to this thread because you are not the owner",
    });
  }

  const {
    harnessId: effectiveHarnessId,
    sandboxProviderKind: effectiveSandboxProviderKind,
    branch: effectiveBranch,
  } = applyThreadLock({
    taskIdInput,
    thread: lockedThread,
    requestedHarnessId: harnessId,
    requestedSandboxProviderKind: sandboxProviderKind,
    requestedBranch: branch,
  });

  const resolvedModels = await resolvePerRequestModels(
    ctx,
    tier,
    effectiveHarnessId,
  );

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
    agent,
    temperature,
    toolApprovalLevel,
    mode,
    organizationId: organization.id,
    userId,
    taskId: taskIdInput,
    windowSize: memoryConfig?.windowSize ?? DEFAULT_WINDOW_SIZE,
    branch: effectiveBranch ?? null,
    sandboxProviderKind: effectiveSandboxProviderKind ?? null,
    harnessId: effectiveHarnessId ?? null,
  };
}

// ============================================================================
// Route Handler
// ============================================================================

export interface DecopilotDeps {
  cancelBroadcast: CancelBroadcast;
  streamBuffer: StreamBuffer;
  runRegistry: RunRegistry;
  /**
   * Live desktop-link status probe. Threaded onto the StudioContext so the
   * decopilot dispatch path can consult the daemon directly. POST /messages
   * uses it to reject early when no link answers instead of silently queueing
   * a run that would have nowhere to go.
   */
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

      // Resolve the dispatch target up-front so we can reject a
      // request with 409 *before* enqueuing it onto the thread gate.
      // Holding the link-online decision at POST time also keeps DBOS
      // replay from rerouting the run if the daemon disconnects between
      // enqueue and dispatch (the workflow body reads target directly off
      // the serialized request).
      //
      // The thread row's (sandbox_provider_kind, harness_id) are the
      // single source of truth for routing. Tolerate storage failure when
      // loading the thread row — a missing/erroring row just means we fall
      // back to the request body / default helpers (the canonical thread row
      // is created by COLLECTION_THREADS_CREATE before the first POST, but
      // legacy callers and tests may skip it).
      let existingThread: Awaited<
        ReturnType<typeof ctx.storage.threads.get>
      > | null = null;
      try {
        existingThread = (await ctx.storage.threads?.get?.(taskId)) ?? null;
      } catch {
        existingThread = null;
      }

      // Fall back to the "ephemeral" synthetic branch when neither the
      // thread row nor the request body pins one. Synthetic branches
      // (see packages/sandbox/daemon-go/internal/gitx/refname.go:isSyntheticBranch) are
      // accepted by the daemon as sandboxMap routing keys but never checked
      // out — exactly the right semantics for Decopilot threads on
      // agents with no clonable repo, where the branch is purely an
      // isolation key.
      const branch = existingThread?.branch ?? input.branch ?? "ephemeral";

      // Determine the pinned (kind, harness). If the thread row has them,
      // use those. Otherwise this is the first message — derive defaults and
      // persist to the thread row.
      let pinnedKind = (existingThread?.sandbox_provider_kind ??
        null) as SandboxProviderKind | null;

      const providerId = await resolveProviderId(
        ctx,
        input.models.credentialId,
        input.organizationId,
      );
      const credentialHarness = resolveHarnessId(providerId);

      let pinnedHarness = (existingThread?.harness_id ??
        null) as HarnessId | null;
      let messageStorageVersion = existingThread?.message_storage_version ?? 2;

      if (!pinnedKind || !pinnedHarness) {
        pinnedKind =
          pinnedKind ??
          input.sandboxProviderKind ??
          resolveSandboxProviderKindFromEnv();
        pinnedHarness = pinnedHarness ?? input.harnessId ?? credentialHarness;

        if (existingThread) {
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
          try {
            // Persist `branch` unconditionally on the initial pin write so
            // the thread row is the single source of truth the lock guard
            // (validate() / applyThreadLock) reads on every follow-up.
            // Previously we only stored the synthetic "ephemeral" fallback
            // (`branchWasDefaulted` path); a user who explicitly picked
            // "main" on the first message would have it dropped here, and
            // the lock would later resolve to null and dispatch against
            // "ephemeral" instead. The lock contract (spec
            // 2026-06-03-lock-thread-harness-and-branch-design.md) says
            // all three locked fields are pinned together — branch is no
            // exception.
            await ctx.storage.threads?.update?.(taskId, {
              sandbox_provider_kind: pinnedKind,
              harness_id: pinnedHarness,
              branch,
              ...(pinV2 ? { message_storage_version: 2 } : {}),
            });
            if (pinV2) messageStorageVersion = 2;
          } catch (err) {
            console.warn(
              "[decopilot:messages] failed to persist thread pins",
              err,
            );
          }
        }
      }

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
        sandboxProviderKind: pinnedKind,
        harnessId: pinnedHarness,
      });
      // The workflow body emits `chat_message_started` inside a DBOS step,
      // so idempotent retries that collapse onto an existing workflowID
      // don't double-count in PostHog. Don't add a duplicate emit here.
      if (
        existingThread?.status !== "in_progress" &&
        shouldPublishClusterRunStatus({
          harnessId: pinnedHarness,
          sandboxProviderKind: pinnedKind,
        })
      ) {
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
  // Cancel Endpoint — cancel ongoing run (local or via NATS to owning pod)
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
    // already-finished/unknown workflow (e.g. desktop runs, which have no
    // hosted child) must not fail the cancel.
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
    await cancelActiveThreadRun({ ctx, taskId, thread, organization, userId });
    return c.json({ cancelled: true, async: true }, 202);
  });

  // Flip a still-running FOREGROUND subtask to the background so the thread gate
  // frees up and the user can keep chatting. Fanned out over NATS to whichever
  // pod runs the turn (like cancel); that pod's running `subtask` call aborts
  // its inline run and re-runs it as a durable background job. Owner-only.
  app.post("/:org/decopilot/flip/:threadId", async (c) => {
    const { taskId } = await validateThreadOwnership(c);
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
    const { ctx, taskId } = await validateThreadOwnership(c);
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
      const { taskId } = await validateThreadAccess(c);
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
