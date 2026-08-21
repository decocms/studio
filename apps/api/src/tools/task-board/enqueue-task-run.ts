import { taskRunMetadata } from "../../billing/subsidized-runs";
import {
  RUN_CLASS_METADATA_KEY,
  type RunClass,
} from "@/dispatch-queue/run-priority";
import type { StudioContext } from "@/core/studio-context";
import type { TaskBoardItem } from "@/storage/types";
import { resolveTier } from "@/core/resolve-tier";
import { enqueueThreadRun } from "@/dispatch-queue";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { getDecopilotId } from "@decocms/shared/sdk";
import type { HostedHarnessId } from "@/api/routes/decopilot/dispatch-run";
import { threadBranch } from "@/tools/sandbox/thread-repo";
import { harnessRunsInSandbox } from "@/harnesses/sandbox-dispatch-client";
import {
  MODEL_CLASS_METADATA_KEY,
  type ClaudeCodeModelClass,
} from "@/harnesses/claude-code-env";
import type { TaskRepo } from "./claude-code-task-run";

/**
 * The single home for the "run the org's agent on a task" plumbing, shared by
 * the Super Agent and the reviewer enqueues (which used to duplicate it): create
 * a fresh thread, link it to the task, persist the seed user turn BEFORE
 * dispatch, then enqueue the run on the durable thread-gate queue. Callers vary
 * only the title, prompt, and temperature. Returns the run thread's id so the
 * caller can record follow-up activity / broadcast against it.
 */
export async function enqueueAgentRunForTask(
  ctx: StudioContext,
  task: TaskBoardItem,
  opts: {
    title: string;
    prompt: string;
    temperature: number;
    /** Hosted harness for this run. Defaults to Decopilot. */
    harnessId?: HostedHarnessId;
    /**
     * Repo to bind to the run's thread BEFORE dispatch, so the pod boots with
     * the checkout already in it. Omitted for a `claude-code` run in an org with
     * several repos: that run gets its own repo-less sandbox on the bare
     * `thread:<id>` key and clones into it with `TASK_ADD_REPO`.
     */
    repo?: TaskRepo;
    /**
     * Per-run agent overrides — instructions (the run's persona) and the
     * built-in tools it must not have. Only the sandbox-hosted harness reads
     * them; a Decopilot fallback run must carry its persona in the prompt.
     */
    agent?: { instructions?: string; disallowedTools?: string[] };
    /**
     * A real git ref this run must land on instead of its own derived branch —
     * the head branch of the pull request a re-run has to update. Without it
     * every re-run gets a fresh `thread:<id>` key, forks a new branch off the
     * default, and opens a SECOND pull request for the same task.
     */
    pinnedRef?: string | null;
    /** Admission class for this run. See `dispatch-queue/run-priority.ts`. */
    runClass?: RunClass;
    /**
     * Model tier for a sandbox-hosted run. `reviewer` puts a verdict-only run
     * on a cheaper model than the Super Agent — see `claude-code-env.ts`.
     * Defaults to the builder's model, which is what every run used before.
     */
    modelClass?: ClaudeCodeModelClass;
    /**
     * Deterministic thread id + run workflow id, for a caller whose triggers can
     * race (the reviewer enqueues). Both are `INSERT … ON CONFLICT DO NOTHING`
     * in effect: the losing racer gets `isNew: false` and nothing is dispatched
     * twice. Omit for a caller with a single trigger.
     */
    fence?: { threadId: string; workflowID: string };
  },
): Promise<{ threadId: string; isNew: boolean }> {
  const organizationId = task.organizationId;
  const userId = task.assignedBy ?? task.createdBy;
  const harnessId = opts.harnessId ?? "decopilot";

  const model = await resolveTier(ctx, "smart");
  const agentId = getDecopilotId(organizationId);

  const thread = await ctx.storage.threads.create({
    ...(opts.fence ? { id: opts.fence.threadId } : {}),
    organization_id: organizationId,
    title: opts.title,
    status: "in_progress",
    virtual_mcp_id: agentId,
    // Consume/terminal writer skips v1 threads — pin v2 or the run never completes.
    message_storage_version: 2,
    harness_id: harnessId,
    sandbox_provider_kind: "agent-sandbox",
    created_by: userId,
  });
  // Another trigger already created this run — it owns the dispatch.
  if (!thread.isNew) return { threadId: thread.id, isNew: false };

  // Bind the repo to the thread the way `load_repo` does — it's the only place a
  // repo persists for the synthetic Super Agent, and it's what makes
  // `resolveSandboxBranch` hand this run a sandbox with the checkout in it. The
  // branch must be the repo-specific one or the run lands in the shared
  // "ephemeral" sandbox with no repo.
  //
  // NOT marked `read_only` any more. A sandbox-hosted run used to answer exactly
  // the one prompt it was dispatched with, so the thread was closed to
  // follow-ups; the messages POST now accepts them and the harness resumes its
  // Claude Code session, which the daemon carries between pods on the org's home
  // volume. The flag and its 409 still exist for a thread that really is closed
  // — nothing sets it.
  //
  // The session is the ONLY context a follow-up gets: the dispatch wire carries
  // one `userMessage` (`harnessStreamInputSchema`) and no history, so a turn
  // whose session did not restore reads "also make it blue" with nothing to
  // resolve "it" against. That is the failure mode `WaitHomeReady` is bounded
  // around, and it is why the home volume is a requirement rather than an
  // optimization.
  const metadata = {
    ...(thread.metadata ?? {}),
    // Read back by `resolveSandboxBranch` at provision time (via the thread, so
    // a durable re-dispatch resolves the same pod). See `pinnedRef` above.
    ...(opts.pinnedRef ? { pinnedRef: opts.pinnedRef } : {}),
    ...(opts.repo
      ? {
          githubRepo: {
            url: opts.repo.url,
            owner: opts.repo.owner,
            name: opts.repo.name,
            installationId: opts.repo.installationId,
            connectionId: opts.repo.connectionId,
          },
        }
      : {}),
  };
  // A sandbox-hosted run with no repo still needs a sandbox of its OWN: it is
  // about to clone into it (`TASK_ADD_REPO`), and the repo-less default is the
  // "ephemeral" sandbox SHARED across the user's threads — two task runs cloning
  // different repos into one pod. The bare `thread:<id>` key is what
  // `resolveSandboxBranch` holds onto for the whole run even once a repo lands,
  // so the claim handle can't move out from under the live pod.
  const sandboxBranch = opts.pinnedRef
    ? opts.pinnedRef
    : opts.repo
      ? threadBranch(thread.id, opts.repo.connectionId)
      : harnessRunsInSandbox(harnessId)
        ? threadBranch(thread.id)
        : null;
  await ctx.storage.threads.update(thread.id, {
    metadata,
    ...(sandboxBranch ? { branch: sandboxBranch } : {}),
    updated_by: userId,
  });

  // Link the run thread to the task (many-to-many) so the board can render it
  // in the card and derive its live run state.
  await ctx.storage.taskBoard.linkThread(task.id, thread.id, organizationId);

  const requestMessage = {
    id: crypto.randomUUID(),
    role: "user" as const,
    parts: [{ type: "text" as const, text: opts.prompt }],
  };

  // Persist the user turn BEFORE dispatch (as POST /messages does) so it lands
  // with an early created_at. The projector runs concurrently with the run's own
  // prepareRun user-message emit; if it projects the assistant reply first, that
  // reply gets base = Date.now() (no user parts yet) and the user message then
  // persists with a LATER created_at — inverting their order in the UI. Writing
  // it here first guarantees user-before-assistant ordering. Idempotent: the
  // run's own emit reuses this same message id (ON CONFLICT keeps this row).
  await new PartEmitter({
    storage: ctx.storage.threads.messageParts(),
    orgId: organizationId,
    threadId: thread.id,
    runId: thread.id,
  }).emitRequestMessage(requestMessage);

  await enqueueThreadRun(
    {
      threadId: thread.id,
      source: "background-tool",
      request: {
        messages: [requestMessage],
        models: {
          credentialId: model.credentialId,
          thinking: { id: model.modelId, title: model.modelMeta.title },
        },
        agent: { id: agentId, ...(opts.agent ?? {}) },
        temperature: opts.temperature,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId,
        userId,
        harnessId,
        sandboxProviderKind: "agent-sandbox",
        // Only meaningful for the repo-less sandbox run above: `resolveSandboxBranch`
        // derives the key from the thread's repo when there is one, and needs the
        // explicit bare key when there isn't. Carried in the durable snapshot, so a
        // recovered re-dispatch resolves the same pod.
        ...(opts.repo ? {} : sandboxBranch ? { branch: sandboxBranch } : {}),
        taskId: thread.id,
        // Reports tasks carry the subscription-billing stamp: their AI usage
        // is included in the org subscription (billing/subsidized-runs.ts).
        // `runClass` orders admission when the pod is at its cap — a reviewer or
        // a retry outranks a brand-new task (see dispatch-queue/run-priority.ts).
        // A free-form metadata string, so it changes no schema and no DBOS step
        // I/O. Defaults to a new task: the class that nothing is waiting on.
        runMetadata: {
          ...taskRunMetadata(task),
          [RUN_CLASS_METADATA_KEY]: opts.runClass ?? "new_task",
          ...(opts.modelClass && opts.modelClass !== "default"
            ? { [MODEL_CLASS_METADATA_KEY]: opts.modelClass }
            : {}),
        },
      },
    },
    opts.fence ? { workflowID: opts.fence.workflowID } : undefined,
  );

  return { threadId: thread.id, isNew: true };
}
