/**
 * SandboxDispatchClient — the `SandboxClient` for harnesses that run INSIDE the
 * sandbox instead of in this process.
 *
 * Decopilot runs in-process (`InProcessSandboxClient`); the Claude Agent SDK
 * cannot — it is a TS library that drives the `claude` CLI, and it belongs next
 * to the checkout. So this client provisions the pod, POSTs the same
 * `HarnessStreamInputWire` to the daemon's `/_sandbox/dispatch`, and yields the
 * turn it answers with as the `UIMessageChunk` iterable every consumer upstream
 * already expects. Nothing downstream of `dispatch()` can tell the difference.
 *
 * STUDIO-OWNED, like its in-process sibling: it closes over StudioContext, so
 * it cannot live in `@decocms/sandbox`.
 *
 * Transport note: one request per run, held open for its whole length, with the
 * daemon streaming newline-delimited `HarnessRunResult` frames as the harness
 * produces them. Each frame's chunks are yielded on arrival, so the projector
 * persists a long turn while it is still running instead of at its end. The
 * response still ends when the run does, so Studio keeps knowing precisely when
 * that was; `withLivenessHeartbeat` upstream covers the quiet stretches.
 *
 * Failure model: the pod holding the agent loop can disappear mid-turn — spot
 * reclaim, an eviction, a node loss — and that is NOT the harness failing. The
 * daemon marks its last frame `done`, so a body that ends without one means the
 * transport died, and a run that goes silent past `DAEMON_SILENCE_TIMEOUT_MS`
 * means the pod stopped answering (its keepalive is every 15s). Either way this
 * client re-provisions and CONTINUES the turn once, telling the harness to pick
 * up the work in the checkout rather than redo it — the dying daemon commits and
 * pushes the worktree on SIGTERM, so a replacement pod clones it back.
 */

import type { UIMessageChunk } from "ai";
import { sleep } from "@decocms/shared/std";
import type { SandboxClient } from "@decocms/sandbox/dispatch/sandbox-client";
import { harnessRunResultSchema } from "@decocms/sandbox/dispatch/schemas";
import {
  SANDBOX_GONE_TERMINAL_CODE,
  SANDBOX_UNREACHABLE_PREFIX,
} from "@decocms/sandbox/dispatch/error-codes";
import type {
  PodTermination,
  SandboxProvider,
} from "@decocms/sandbox/provider";
import { isTransientStreamError } from "@/harnesses/decopilot/built-in-tools/subtask";
import type { HarnessId, HarnessStreamInput } from "@/harnesses/lib/types";
import {
  claudeCodeEnvFromCredential,
  modelClassFromMetadata,
  MODEL_CLASS_METADATA_KEY,
  type ClaudeCodeCredential,
} from "@/harnesses/claude-code-env";
import { mergeRunEnv, resolveOrgRunEnv } from "@/harnesses/org-run-env";
import { withModelMetadata } from "@/harnesses/with-model-metadata";
import type { StudioContext } from "../core/studio-context";
import { mintMcpEndpoint } from "@/mcp-clients/virtual-mcp/mint-endpoint";
import { resolveSandboxProvider } from "@/sandbox/resolve-provider";
import { getSettings } from "@/settings";
import { ensureSandbox } from "@/tools/sandbox/start";
import {
  getThreadGithubRepo,
  syntheticBranchToGitRef,
  threadBranch,
} from "@/tools/sandbox/thread-repo";

/**
 * Working directory the harness runs in, as the daemon names it.
 *
 * The daemon rebases exactly `/repo` onto its own app root (`RebaseWorkspaceCwd`
 * in daemon-go), so this is the one value that lands on the checkout wherever
 * the pod puts it. Any other path — including the real `/app/repo` — is
 * rewritten to `null`, which would run the harness in the runner's cwd instead
 * of the repository it was asked to work in.
 */
const SANDBOX_REPO_CWD = "/repo";

/** Harnesses this client can dispatch. Decopilot is in-process, never here. */
const SANDBOX_HOSTED_HARNESSES = new Set<HarnessId>(["claude-code"]);

/**
 * Dispatches per run WITHOUT PROGRESS: the first, plus ONE continuation after
 * the sandbox goes away. A second failure that streamed nothing is the run's
 * failure — re-provisioning a sandbox that keeps dying on boot burns model
 * budget on a turn that never lands, and the durable path already retries at a
 * higher level (DBOS recovery re-enters this client with the run's seq floor
 * intact).
 *
 * Counted CONSECUTIVELY, not per run: the break this bounds is the apiserver
 * hanging up the daemon's port-forward, which is a routine blip, not a sick
 * pod. A lifetime budget failed runs that had streamed thirty tool calls
 * between two unrelated hangups minutes apart — which is exactly the run this
 * is meant to save, and it also burns the org's task quota. Any chunk from the
 * replacement pod proves the continuation worked, so it resets the count.
 */
const MAX_DISPATCH_ATTEMPTS = 2;

/**
 * Hard ceiling on dispatches per run, however much progress each one makes.
 * Guards the pathological shape the consecutive count alone would loop on: a
 * pod that answers with one chunk and dies, forever.
 */
const MAX_TOTAL_DISPATCH_ATTEMPTS = 5;

/**
 * How long Studio waits for ANY byte from the daemon before calling the pod
 * gone. The daemon writes a keepalive newline every 15s while the harness is
 * quiet, so silence past this is the pod not answering — not a slow model.
 *
 * This is the ONLY thing that bounds a lost node: `withLivenessHeartbeat`
 * upstream injects its heartbeat on Studio's own clock, so it keeps a run that
 * is reading from a dead socket looking alive to the reaper indefinitely.
 */
const DAEMON_SILENCE_TIMEOUT_MS = 90_000;

/**
 * The sandbox, not the harness, is what failed — so the turn can be continued
 * on a replacement pod. A harness that crashes reports through its own terminal
 * frame instead, and that is a real terminal we must not paper over by re-running
 * the model.
 */
export class SandboxUnreachableError extends Error {
  /**
   * The bare reason, without the prefix — so a caller that learns WHY the pod
   * went away can re-wrap without doubling the marker.
   */
  readonly reason: string;

  constructor(reason: string, infra?: string) {
    // Prefixed in the CONSTRUCTOR, so the marker `isTransientRunFailure` reads
    // downstream cannot be forgotten by a new throw site. See
    // SANDBOX_UNREACHABLE_PREFIX.
    super(
      `${SANDBOX_UNREACHABLE_PREFIX} ${reason}${infra ? ` — ${infra}` : ""}`,
    );
    this.name = "SandboxUnreachableError";
    this.reason = reason;
  }
}

/**
 * A newer dispatch of this run took the sandbox over, so THIS attempt is no
 * longer the run's writer — the successor is, and it will publish the run's
 * terminal. Distinct from every other failure because the run has not failed
 * at all; only this attempt has stopped, and it must stop QUIETLY:
 *
 * - not a `SandboxUnreachableError`: continuing would re-dispatch the same
 *   runId and take the run back off the successor, trading it back and forth;
 * - not a plain `Error`: that becomes the run's fence-scoped error terminal
 *   (see `hostedHarnessWorkflowFn`), which is what settled a live thread as
 *   `Error: cancelled: run cancelled` in prod on 2026-08-07.
 *
 * Two attempts exist for one turn whenever the pod running it goes away and DBOS
 * recovers the workflow elsewhere — a rolling deploy, an eviction, or KEDA
 * scaling in a worker that was mid-run.
 */
export class RunSupersededError extends Error {
  /**
   * Own-enumerable marker, NOT an `instanceof` check, because this error is
   * thrown from inside a DBOS step: DBOS serializes a step's error through
   * `serialize-error` for its durable journal and reconstructs a plain `Error`
   * on replay, losing the subclass — but own-enumerable properties survive that
   * round trip. Same idiom as `WithLastAckSeq` / `PermanentRunError.permanent`.
   * Read it via `isRunSuperseded`, never with `instanceof`.
   */
  readonly superseded = true;

  constructor(reason: string) {
    super(reason);
    this.name = "RunSupersededError";
  }
}

/** See `RunSupersededError.superseded` for why this is not an `instanceof`. */
export function isRunSuperseded(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { superseded?: boolean }).superseded === true
  );
}

/** The daemon's terminal code for an attempt displaced by a takeover. */
const SUPERSEDED_TERMINAL_CODE = "superseded";

/**
 * Is a non-2xx dispatch response the sandbox being gone, or the daemon rejecting
 * the envelope? 404/410 is the proxy finding no pod (or a reprovisioned one that
 * never adopted the claim) and 5xx is the pod failing to answer at all — both
 * retriable on a fresh sandbox. A 4xx from the daemon itself (bad input,
 * unauthorized, tombstoned) would fail the same way forever.
 */
export function isUnreachableStatus(status: number): boolean {
  return status === 404 || status === 410 || status >= 500;
}

/**
 * Widened past `HarnessId` so callers holding a raw `threads.harness_id` can ask
 * without an `as`-cast — a cast there would hide a renamed harness until
 * runtime. A Set lookup is total over strings, so nothing is lost.
 */
export function harnessRunsInSandbox(
  harnessId: string | null | undefined,
): boolean {
  return SANDBOX_HOSTED_HARNESSES.has(harnessId as HarnessId);
}

export class SandboxDispatchClient implements SandboxClient {
  private readonly ctx: StudioContext;
  private readonly harnessId: HarnessId;
  private readonly virtualMcpId: string;
  private readonly branch: string;
  private readonly credential: ClaudeCodeCredential | null;
  private readonly resume: { reason: string } | null;

  constructor(args: {
    ctx: StudioContext;
    harnessId: HarnessId;
    virtualMcpId: string;
    branch: string;
    /** Resolved thinking-slot credential; becomes the sandbox's model env. */
    credential: ClaudeCodeCredential | null;
    /**
     * Set when the caller knows this dispatch continues a turn a previous
     * Studio process started (see `dispatch-run.ts`'s `resumeFromSeq`). A
     * sandbox that dies mid-turn is handled inside this client instead, which
     * supplies its own reason.
     */
    resume?: { reason: string };
  }) {
    if (!harnessRunsInSandbox(args.harnessId)) {
      throw new Error(
        `SandboxDispatchClient runs sandbox-hosted harnesses only; got "${args.harnessId}"`,
      );
    }
    this.ctx = args.ctx;
    this.harnessId = args.harnessId;
    this.virtualMcpId = args.virtualMcpId;
    this.branch = args.branch;
    this.credential = args.credential;
    this.resume = args.resume ?? null;
  }

  dispatch(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
    return this.stream(input);
  }

  /**
   * Where the harness works, and on what.
   *
   * `cwd: "/repo"` normally comes with a repo behind it. The one case it doesn't
   * is a task run dispatched on the bare `thread:<id>` key: that run got its own
   * (repo-less) sandbox precisely so it could clone a repo into this directory
   * mid-run with `TASK_ADD_REPO`, and the daemon creates the directory at boot,
   * so pointing the harness at it up front is honest — and it is the only way
   * the harness ends up standing in the checkout, since its cwd is fixed when
   * the process spawns.
   *
   * A thread with no repo on any OTHER key shares the `ephemeral` sandbox, which
   * has no checkout at all — `cwd: null` stays correct there.
   */
  private async resolveWorkspace(
    threadId: string,
  ): Promise<HarnessStreamInput["workspace"]> {
    const repo = await getThreadGithubRepo(this.ctx, threadId);
    if (!repo) {
      return this.branch === threadBranch(threadId)
        ? {
            cwd: SANDBOX_REPO_CWD,
            branch: syntheticBranchToGitRef(this.branch),
          }
        : { cwd: null };
    }
    return {
      cwd: SANDBOX_REPO_CWD,
      repo: {
        owner: repo.owner,
        name: repo.name,
        connectedGithub: Boolean(repo.connectionId),
      },
      // The synthetic sandbox key is not a git ref; the daemon checks out its
      // derived branch, so that is the one the harness is standing on.
      branch: this.branch.startsWith("thread:")
        ? syntheticBranchToGitRef(this.branch)
        : this.branch,
    };
  }

  private async *stream(
    input: HarnessStreamInput,
  ): AsyncIterable<UIMessageChunk> {
    if (!this.credential) {
      throw new Error(
        `the ${this.harnessId} harness needs a resolved model credential; ` +
          `this run has none (check the agent's thinking model)`,
      );
    }
    // Fail on an unusable provider BEFORE provisioning a pod: the alternative
    // is a booted sandbox that dies on an opaque model error minutes later.
    const modelEnv = claudeCodeEnvFromCredential(
      this.credential,
      modelClassFromMetadata(
        this.ctx.metadata?.runMetadata?.[MODEL_CLASS_METADATA_KEY],
      ),
    );
    const organization = this.ctx.organization;
    if (!organization) {
      throw new Error(
        `the ${this.harnessId} harness needs an organization on the context ` +
          `to mint its MCP endpoint; this run has none`,
      );
    }

    // Resolved before the pod exists; model credential wins — see `mergeRunEnv`.
    const runEnv = mergeRunEnv(
      await resolveOrgRunEnv(this.ctx, input.user.id),
      modelEnv,
    );

    const { provider, kind } = await resolveSandboxProvider(this.ctx, {
      userId: input.user.id,
      branch: this.branch,
      virtualMcpMetadata: null,
    });
    const wireInput = {
      ...input,
      // Hosted Decopilot's in-process client ignores `mcp` and gets the
      // sentinel `{url: "", ...}`. This harness is a real MCP client in
      // another process, so it needs a real endpoint — without one the
      // daemon rejects the envelope outright, and the org's tools (moving
      // the task on the board, for one) would be unreachable anyway.
      //
      // The task-run surface, NOT the agent's own: super-agent task runs
      // dispatch as Decopilot, which by design aggregates no connections
      // (`storage/virtual.ts` findById returns `connections: []`) because
      // hosted Decopilot reaches TASK_BOARD_* by `subtask`-delegating to the
      // Task Manager agent. This harness has no `subtask`, so pointing it at
      // the agent's virtual MCP yielded `connected` with zero tools.
      //
      // Scoped to this run (thread id in the path) and narrow: the task-board
      // tools plus `TASK_ADD_REPO`. It used to be `/mcp/self` — every management
      // tool Studio has, ~200 of them, for the two this harness calls.
      //
      // ponytail: one surface, not both — the agent's aggregated connections
      // are not merged in. Add a second MCP server on the wire if a
      // claude-code run ever needs an agent's own external tools.
      mcp: await mintMcpEndpoint(
        this.ctx,
        this.virtualMcpId,
        organization,
        `${this.harnessId}-run`,
        "task-run",
        input.threadId,
      ),
      // Hosted Decopilot mounts no working directory; this harness edits the
      // checkout the daemon prepared.
      workspace: await this.resolveWorkspace(input.threadId),
    };

    // The daemon keys cancellation (`DELETE /_sandbox/runs/:runId`) by this id,
    // and Studio's run identity is the thread — same key the rest of the hosted
    // pipeline uses for the run. It is also what makes a re-dispatch a TAKEOVER
    // rather than a second agent in the same checkout (see the daemon's
    // `Registry.claim`).
    const runId = input.threadId;
    const { ctx, harnessId, virtualMcpId, branch } = this;
    const credentialProviderId = this.credential.providerId;

    // Provisioning is re-done per attempt on purpose. On the continuation path
    // the pod is gone, and `ensureSandbox` + `pushSandboxEnv` are what put a
    // replacement behind the same handle: the ensure clones the branch the dying
    // daemon pushed on its way out, and the env push is not optional either —
    // the model credential lives in the daemon's own config, which a fresh pod
    // boots without.
    // The last handle a dispatch attempt actually ran on, so the release below
    // targets the pod that survived the continuation rather than one already
    // replaced. Written per attempt; read once, after the run settles.
    let lastHandle: string | null = null;
    const dispatchOnce = (
      resume: { reason: string } | null,
    ): AsyncIterable<UIMessageChunk> =>
      (async function* () {
        const sandbox = await ensureSandbox(
          {
            virtualMcpId,
            branch,
            sandboxProviderKind: kind,
            // One agent loop, no preview, and a memory ceiling of its own.
            purpose: "harness-run",
          },
          ctx,
        );
        lastHandle = sandbox.sandboxHandle;
        // The daemon deep-merges its config, so re-running on an already-claimed
        // sandbox just rotates the credential.
        await pushSandboxEnv(provider, sandbox.sandboxHandle, runEnv);
        yield* withModelMetadata(
          dispatchToDaemon({
            provider,
            handle: sandbox.sandboxHandle,
            harnessId,
            input: resume ? { ...wireInput, resume } : wireInput,
            runId,
            signal: input.signal,
          }),
          // A continuation's `start` is dropped downstream, so don't re-stamp it.
          resume ? null : modelEnv.CLAUDE_CODE_MODEL,
          credentialProviderId,
        );
      })();

    try {
      yield* dispatchWithContinuation({
        runId,
        resume: this.resume,
        aborted: () => input.signal?.aborted === true,
        dispatchOnce,
        lastHandle: () => lastHandle,
        describeTermination: async (handle) =>
          handle === null
            ? null
            : describeTermination(
                (await provider.lastTermination?.(handle)) ?? null,
              ),
      });
    } finally {
      // The run is over — cleanly, failed, or aborted. This pod is `cloneOnly`:
      // one agent loop, no dev server, nothing serving a preview URL. Left
      // alone it idles to the 15-min claim TTL, which for a 100s run is most of
      // its billed life. Bring shutdown forward instead.
      //
      // In `finally` on purpose: a failed or cancelled run's pod is exactly as
      // useless as a successful one's. `releaseAfter` only ever moves shutdown
      // earlier and swallows its own errors, so this cannot fail a run or cut
      // short a sandbox another turn just extended.
      if (lastHandle && getSettings().sandboxReleaseOnRunEndEnabled) {
        await provider
          .releaseAfter?.(lastHandle, getSettings().sandboxReleaseGraceMs)
          .catch(() => {});
      }
    }
  }
}

/**
 * Dispatch a turn, continuing it on a replacement sandbox if the one running it
 * disappears. The policy, with the provisioning injected as `dispatchOnce` so it
 * is a unit.
 *
 * Two things make a continuation safe to splice into a run that is already
 * streaming:
 *
 *  - Only `SandboxUnreachableError` is retried. A harness that crashed reported a
 *    terminal, and re-running the model on it would bill a second full turn for a
 *    failure that will repeat.
 *  - The continuation's own `start` chunk is dropped. `start` RENAMES the message
 *    being folded (AI SDK `processUIMessageStream` assigns `state.message.id`),
 *    so forwarding a second one re-ids a message the projector has already
 *    written parts for. The first `start` of the run wins — but if the interrupted
 *    attempt died before sending one, the continuation's IS the first and passes,
 *    or the run's message never opens at all.
 *
 * What it does NOT do is re-run the task: `resume` tells the harness its own
 * context is gone but the work is in the checkout, so it continues from there.
 */
export async function* dispatchWithContinuation(args: {
  runId: string;
  /** Set when the CALLER already knows this run is a continuation. */
  resume: { reason: string } | null;
  /** True when the consumer asked us to stop — never something to route around. */
  aborted: () => boolean;
  dispatchOnce: (
    resume: { reason: string } | null,
  ) => AsyncIterable<UIMessageChunk>;
  /**
   * Ask the infrastructure why the sandbox went away, once it has. Answers the
   * question the broken stream cannot: an OOM kill leaves no trace in the
   * daemon's output, so without this both the agent and the user are told only
   * that the pod "stopped answering" — and a run that OOMs twice reads as a
   * flaky network instead of a sandbox too small for the work.
   *
   * Best-effort: null (or a throw) degrades to the unqualified message.
   */
  describeTermination?: (handle: string | null) => Promise<string | null>;
  /** The handle the failed attempt ran on, for `describeTermination`. */
  lastHandle?: () => string | null;
  /** Consecutive no-progress dispatches allowed. */
  maxAttempts?: number;
  /** Dispatches allowed in total, progress or not. */
  maxTotalAttempts?: number;
}): AsyncIterable<UIMessageChunk> {
  const maxAttempts = args.maxAttempts ?? MAX_DISPATCH_ATTEMPTS;
  const maxTotalAttempts = args.maxTotalAttempts ?? MAX_TOTAL_DISPATCH_ATTEMPTS;
  let resume = args.resume;
  let forwardedStart = resume !== null;
  /** Consecutive failures whose dispatch streamed nothing. */
  let stalled = 0;

  for (let attempt = 1; ; attempt++) {
    let progressed = false;
    try {
      for await (const chunk of args.dispatchOnce(resume)) {
        progressed = true;
        if ((chunk as { type?: string }).type === "start") {
          if (forwardedStart) continue;
          forwardedStart = true;
        }
        yield chunk;
      }
      return;
    } catch (err) {
      if (args.aborted()) throw err;
      stalled = progressed ? 0 : stalled + 1;
      const infra =
        err instanceof SandboxUnreachableError
          ? ((await args
              .describeTermination?.(args.lastHandle?.() ?? null)
              .catch(() => null)) ?? null)
          : null;
      if (
        isRunSuperseded(err) ||
        !(err instanceof SandboxUnreachableError) ||
        stalled >= maxAttempts ||
        attempt >= maxTotalAttempts
      ) {
        // Out of attempts — this message is the run's error terminal, what the user reads.
        if (infra && err instanceof SandboxUnreachableError) {
          throw new SandboxUnreachableError(err.reason, infra);
        }
        throw err;
      }
      console.warn("[sandbox-dispatch] sandbox lost mid-run; continuing", {
        runId: args.runId,
        attempt,
        progressed,
        reason: err.message,
        termination: infra,
      });
      resume = { reason: resumeReason(err.message, infra) };
    }
  }
}

/**
 * What the harness is told about the sandbox it lost. `infra` is the
 * infrastructure's verdict when we have one (an OOM kill, typically).
 *
 * The instructions are the point: the continuation runs in a pod that has the
 * branch but not the transcript, so left to itself a model either re-runs the
 * work that just died — reproducing the kill — or reports success from memory
 * of edits that were never pushed.
 */
function resumeReason(errorMessage: string, infra: string | null): string {
  const lost = `the sandbox running the previous attempt stopped answering (${errorMessage})`;
  if (!infra) return lost;
  return (
    `${lost}. ${infra}. A replacement sandbox has been started from the last state pushed to the branch. ` +
    `Tell the user this happened, re-read the files you had been editing rather than trusting your memory of them, ` +
    `and if a step needs more memory than the sandbox has, split it instead of repeating what was killed`
  );
}

/**
 * The kubelet's verdict as one sentence for a prompt, a log line, and a thread
 * error — the same text for all three, because an OOM the agent is told about
 * and the user is not is how "it just stopped" survived in prod.
 *
 * Null for a stop that carries no information beyond the broken stream we
 * already reported (a graceful shutdown, an eviction, a pod already gone).
 */
export function describeTermination(
  termination: PodTermination | null,
): string | null {
  if (!termination) return null;
  if (termination.oomKilled) {
    const limit = termination.memoryLimit
      ? ` (memory limit ${termination.memoryLimit})`
      : "";
    return `it was killed by the kernel for exceeding its memory limit${limit} — OOMKilled`;
  }
  if (termination.reason === "Completed") return null;
  const code =
    termination.exitCode === undefined
      ? ""
      : ` (exit code ${termination.exitCode})`;
  return `the sandbox container terminated with reason ${termination.reason}${code}`;
}

/**
 * Bound the env-push PUT — a wedged daemon (pod up, TCP open, nothing
 * draining it) must not hang the dispatch forever. `DAEMON_SILENCE_TIMEOUT_MS`
 * only bounds the streaming dispatch itself; this call happens before that
 * stream even opens, so without its own timeout it has no ceiling at all.
 */
const PUSH_ENV_TIMEOUT_MS = 30_000;

/**
 * PUT the run's model env onto the daemon's config channel.
 *
 * ⚠️ SECURITY: `env` holds a model credential. Never log it, and never include
 * the request body in an error message.
 */
export async function pushSandboxEnv(
  provider: SandboxProvider,
  handle: string,
  env: Record<string, string | null>,
): Promise<void> {
  let res: Response;
  try {
    res = await provider.proxyDaemonRequest(handle, "/_sandbox/config", {
      method: "PUT",
      headers: new Headers({ "content-type": "application/json" }),
      body: JSON.stringify({ env }),
      signal: AbortSignal.timeout(PUSH_ENV_TIMEOUT_MS),
    });
  } catch (err) {
    // A wedged or dead daemon here is exactly what dispatchToDaemon's own fetch already retries on a replacement.
    throw new SandboxUnreachableError(
      `could not push the model env to the sandbox: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const summary = `failed to push model env to the sandbox (${res.status} ${res.statusText})`;
    // 404/410/5xx is the pod, not the envelope — retriable, same split as dispatchToDaemon.
    if (isUnreachableStatus(res.status)) {
      throw new SandboxUnreachableError(summary);
    }
    throw new Error(summary);
  }
}

/**
 * `signal` is an AbortSignal and the run context is attached out-of-band; both
 * are dropped here. Everything else on `HarnessStreamInput` is the wire shape.
 */
function toWireInput(input: HarnessStreamInput): unknown {
  const { signal: _signal, ...wire } = input;
  return wire;
}

/**
 * How often a streaming dispatch pushes its sandbox's shutdown deadline out.
 * Same cadence as the preview SSE handler's `TTL_RENEW_MS`, and for the same
 * reason: comfortably inside the 15-minute claim TTL, so a missed renewal (or a
 * slow apiserver) still leaves two more chances before the pod is reaped.
 */
const TTL_RENEW_MS = 5 * 60_000;

/**
 * Keep the claim alive on an interval, returning the stop. Best-effort by
 * construction — a failed renewal costs the run its pod at the deadline, which
 * is exactly today's behavior, so it must never break the stream it is
 * protecting.
 */
function renewWhileStreaming(
  provider: SandboxProvider,
  handle: string,
): () => void {
  if (!provider.renewTtl) return () => {};
  const renew = () =>
    void provider
      .renewTtl?.(handle)
      .catch((err) =>
        console.warn(
          `[sandbox-dispatch] TTL renew failed for ${handle}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  // Immediately as well as on the interval: a run dispatched onto a reused
  // sandbox is adopting a TTL that is already part-spent — that is how a run
  // could die four minutes in.
  renew();
  const timer = setInterval(renew, TTL_RENEW_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

async function* dispatchToDaemon(args: {
  provider: SandboxProvider;
  handle: string;
  harnessId: HarnessId;
  runId: string;
  input: HarnessStreamInput;
  signal?: AbortSignal;
}): AsyncIterable<UIMessageChunk> {
  // Attribute the outcome. A transport-level failure here arrives as a bare
  // "operation timed out" with no run, no handle and no duration on it, which is
  // indistinguishable from a model error until you go read pod logs.
  const startedAt = Date.now();
  let res: Response;
  try {
    res = await args.provider.proxyDaemonRequest(
      args.handle,
      "/_sandbox/dispatch",
      {
        method: "POST",
        headers: new Headers({ "content-type": "application/json" }),
        body: JSON.stringify({
          harnessId: args.harnessId,
          runId: args.runId,
          input: toWireInput(args.input),
        }),
        ...(args.signal ? { signal: args.signal } : {}),
      },
    );
  } catch (err) {
    // The proxy could not reach the pod at all (port-forward gone, TLS to a
    // dead node, ECONNRESET). Nothing ran, so this is always safe to continue
    // on a replacement.
    if (args.signal?.aborted) throw err;
    throw new SandboxUnreachableError(
      `could not reach the sandbox daemon: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    const summary = `sandbox dispatch failed (${res.status}): ${detail.slice(0, 512)}`;
    // 404/410/5xx is the pod, not the envelope — retriable on a fresh sandbox.
    // Anything else the daemon would reject the same way forever (bad input,
    // unauthorized, tombstoned run), so it surfaces as the run's failure rather
    // than an empty successful run.
    if (isUnreachableStatus(res.status)) {
      throw new SandboxUnreachableError(summary);
    }
    throw new Error(summary);
  }
  if (!res.body) throw new SandboxUnreachableError("dispatch returned no body");
  // Hold the pod open for as long as this run streams.
  //
  // A claim is created with `spec.lifecycle.shutdownTime = now + 15min`
  // (`DEFAULT_IDLE_TTL_MS`) and the operator deletes the pod at that instant.
  // `renewTtl` pushes it forward — and until now its ONLY caller was the
  // preview SSE handler, i.e. a browser being attached. A Super Agent run has
  // no browser, so nothing renewed it and every headless run had a hard
  // 15-minute wall clock: at the deadline the operator SIGTERMs the daemon,
  // `CancelAll` fires, and the turn dies mid-edit. That is the sandbox_gone
  // case above, and it is why one prod card burned six runs without ever
  // opening a PR.
  //
  // Deliberately NOT the daemon's `/idle` activity — that feeds the
  // housekeeper's idle sweep, which can only end a claim early, never extend
  // it. The claim's own deadline is a separate clock and this is the only thing
  // that moves it.
  const stopTtlRenew = renewWhileStreaming(args.provider, args.handle);
  let total = 0;
  // Sticky, and only acted on after every frame's chunks are yielded: partial
  // work first, THEN the throw, because the consumer's error path is what
  // records the run as failed and it must not also lose the turn's work. Sticky
  // because the daemon's terminal frame follows a harness's own error frame, and
  // the FIRST reason is the real one.
  let error: { code: string; message: string } | null = null;
  let done = false;
  try {
    for await (const line of ndjsonLines(res.body, args.signal)) {
      const parsed = harnessRunResultSchema.safeParse(line);
      if (!parsed.success) {
        throw new Error(
          `sandbox dispatch returned a malformed frame: ${parsed.error.message}`,
        );
      }
      total += parsed.data.chunks.length;
      yield* parsed.data.chunks as UIMessageChunk[];
      error ??= parsed.data.error;
      if (parsed.data.done) done = true;
    }
  } finally {
    // Every exit path, including the consumer abandoning this generator: a
    // leaked interval would keep a dead sandbox's claim alive for the rest of
    // the process's life.
    stopTtlRenew();
  }
  console.log("[sandbox-dispatch] run ended", {
    runId: args.runId,
    handle: args.handle,
    chunks: total,
    elapsedMs: Date.now() - startedAt,
    done,
    error: error?.code ?? null,
  });
  // A body that ends without the daemon's terminal frame means the pod stopped
  // mid-turn: the run is still owed an ending, and the work so far is in the
  // checkout (and, if the daemon caught SIGTERM, pushed to the branch). Continue
  // it rather than reporting a turn that simply stops.
  if (!done && !error) {
    throw new SandboxUnreachableError(
      `the sandbox stopped streaming after ${total} chunks without finishing the run`,
    );
  }
  if (error) throw errorForTerminal(error.code, error.message);
}

/**
 * What a daemon terminal frame means to this side. Three outcomes, and which
 * one a code gets decides whether the turn is continued, dropped quietly, or
 * failed — so it is pure and unit-tested rather than buried in the stream loop.
 *
 * - `superseded`: another dispatch owns this run now. Whatever this attempt
 *   streamed is already yielded; the successor publishes the terminal.
 * - `sandbox_gone`: the pod could not finish — it was shutting down (eviction,
 *   scale-in) or our connection to it dropped. Nobody cancelled anything, so it
 *   continues on a replacement pod exactly like a broken stream does. The
 *   daemon used to report this case as `cancelled`, which reached the thread as
 *   `Error: cancelled: run cancelled` and was never retried, on a turn whose
 *   work was already committed to the branch by the shutdown publish.
 * - anything else (`harness_crashed`, `cancelled`, `bad_input`, …): a real
 *   terminal the run reported. Failing is the answer.
 */
export function errorForTerminal(code: string, message: string): Error {
  if (code === SUPERSEDED_TERMINAL_CODE) return new RunSupersededError(message);
  if (code === SANDBOX_GONE_TERMINAL_CODE) {
    return new SandboxUnreachableError(message);
  }
  return new Error(`${code}: ${message}`);
}

/**
 * Parse the daemon's response body as newline-delimited JSON.
 *
 * Blank lines are the daemon's keepalive (it writes a lone newline while the
 * harness is quiet), so they are skipped rather than parsed — but they DO count
 * as the pod being alive, which is the whole point of the silence window below.
 *
 * Every read races `DAEMON_SILENCE_TIMEOUT_MS`, because a lost node does not
 * close the socket: without this the read hangs forever while
 * `withLivenessHeartbeat` keeps publishing on Studio's clock, so the run looks
 * healthy to the reaper and holds its thread's queue slot indefinitely.
 */
export async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = function* (rest: boolean) {
    const lines = buffer.split("\n");
    buffer = rest ? (lines.pop() ?? "") : "";
    for (const line of lines) {
      if (line.trim().length === 0) continue;
      try {
        yield JSON.parse(line) as unknown;
      } catch (err) {
        // Not the daemon's keepalive (blank) and not valid JSON either — the
        // stream itself is corrupt, distinct from a well-formed frame failing
        // schema validation upstream. Surface which line, since a bare
        // SyntaxError gives no way to tell which byte of a long-running turn
        // broke.
        throw new Error(
          `sandbox dispatch produced a non-JSON line: ${err instanceof Error ? err.message : String(err)} ` +
            `(line: ${line.slice(0, 256)})`,
        );
      }
    }
  };
  const reader = (body as unknown as AsyncIterable<Uint8Array>)[
    Symbol.asyncIterator
  ]();
  try {
    for (;;) {
      const idle = new AbortController();
      const next = reader.next().then((r) => {
        idle.abort();
        return r;
      });
      const timeout = sleep(DAEMON_SILENCE_TIMEOUT_MS, { signal: idle.signal })
        .then(() => "silent" as const)
        .catch(() => "read-won" as const);
      const step = await Promise.race([next, timeout]).catch((err: unknown) => {
        // The body's socket broke mid-run. This is the port-forward
        // WebSocket to the pod (`AgentSandboxRunner.openForwarder`), and the
        // API server hanging it up is not the harness failing — the checkout
        // is intact and the turn is continuable, exactly like the silence
        // timeout below. Without this the read rejection travels as a plain
        // Error, `dispatchWithContinuation` refuses to retry it, and a
        // transient socket close permanently fails the run (and burns the
        // org's task quota).
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (!isTransientStreamError(message)) throw err;
        throw new SandboxUnreachableError(
          `the sandbox stream broke mid-run: ${message}`,
        );
      });
      if (step === "silent") {
        if (signal?.aborted) return;
        throw new SandboxUnreachableError(
          `no output from the sandbox for ${DAEMON_SILENCE_TIMEOUT_MS / 1000}s ` +
            `(its keepalive is every 15s, so the pod is gone)`,
        );
      }
      // The read resolved first and aborted the timer; loop for the next one.
      if (step === "read-won") continue;
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      yield* drain(true);
    }
    // Flush a multi-byte character `{ stream: true }` held back mid-sequence.
    buffer += decoder.decode();
    yield* drain(false);
  } finally {
    // Close the socket on every exit path — a thrown silence timeout otherwise
    // leaves the request (and the daemon's run) hanging behind us.
    await reader.return?.().catch(() => {});
  }
}
