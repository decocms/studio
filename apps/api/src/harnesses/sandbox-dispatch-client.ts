/**
 * SandboxDispatchClient — the `SandboxClient` for harnesses that run INSIDE the
 * sandbox instead of in this process.
 *
 * Decopilot runs in-process (`InProcessSandboxClient`); the Claude Agent SDK
 * cannot — it is a TS library that drives the `claude` CLI, and it belongs next
 * to the checkout. So this client provisions the pod, POSTs the same
 * `HarnessStreamInputWire` to the daemon's `/_sandbox/dispatch`, and turns the
 * SSE response back into the `UIMessageChunk` iterable every consumer upstream
 * already expects. Nothing downstream of `dispatch()` can tell the difference.
 *
 * STUDIO-OWNED, like its in-process sibling: it closes over StudioContext, so
 * it cannot live in `@decocms/sandbox`.
 *
 * Transport note: this holds the SSE response open for the whole run rather
 * than pushing turns back over a new route. The daemon already speaks exactly
 * this envelope, so there is no new wire, no new table and no new subject —
 * and Studio keeps the one thing a push model gives up, which is knowing
 * precisely when the run ended. The harness itself buffers per turn, so the
 * connection is quiet during work; `withLivenessHeartbeat` upstream covers
 * that silence.
 */

import type { UIMessageChunk } from "ai";
import type { SandboxClient } from "@decocms/sandbox/dispatch/sandbox-client";
import { dispatchSSEEventSchema } from "@decocms/sandbox/dispatch/schemas";
import type { SandboxProvider } from "@decocms/sandbox/provider";
import type { HarnessId, HarnessStreamInput } from "@/harnesses/lib/types";
import {
  claudeCodeEnvFromCredential,
  type ClaudeCodeCredential,
} from "@/harnesses/claude-code-env";
import type { StudioContext } from "../core/studio-context";
import { mintMcpEndpoint } from "@/mcp-clients/virtual-mcp/mint-endpoint";
import { resolveSandboxProvider } from "@/sandbox/resolve-provider";
import { ensureSandbox } from "@/tools/sandbox/start";
import {
  getThreadGithubRepo,
  syntheticBranchToGitRef,
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

  constructor(args: {
    ctx: StudioContext;
    harnessId: HarnessId;
    virtualMcpId: string;
    branch: string;
    /** Resolved thinking-slot credential; becomes the sandbox's model env. */
    credential: ClaudeCodeCredential | null;
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
  }

  dispatch(input: HarnessStreamInput): AsyncIterable<UIMessageChunk> {
    return this.stream(input);
  }

  /**
   * Where the harness works, and on what.
   *
   * `cwd: "/repo"` is only meaningful with a repo behind it — the wire shape
   * makes that explicit, and it is the honest thing to send: a run whose thread
   * has no bound repo got an `ephemeral` sandbox with no checkout, so naming a
   * working directory there would describe a directory that doesn't exist.
   */
  private async resolveWorkspace(
    threadId: string,
  ): Promise<HarnessStreamInput["workspace"]> {
    const repo = await getThreadGithubRepo(this.ctx, threadId);
    if (!repo) return { cwd: null };
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
    const modelEnv = claudeCodeEnvFromCredential(this.credential);
    const organization = this.ctx.organization;
    if (!organization) {
      throw new Error(
        `the ${this.harnessId} harness needs an organization on the context ` +
          `to mint its MCP endpoint; this run has none`,
      );
    }

    const { provider, kind } = await resolveSandboxProvider(this.ctx, {
      userId: input.user.id,
      branch: this.branch,
      virtualMcpMetadata: null,
    });
    const sandbox = await ensureSandbox(
      {
        virtualMcpId: this.virtualMcpId,
        branch: this.branch,
        sandboxProviderKind: kind,
        // This pod runs one agent loop and returns its output. Nothing here
        // opens a preview, so the tenant's install + dev server is pure boot
        // latency — the harness only needs the checkout.
        cloneOnly: true,
      },
      this.ctx,
    );
    // Push the model env before dispatching. The daemon deep-merges its config,
    // so re-running on an already-claimed sandbox just rotates the credential.
    await pushSandboxEnv(provider, sandbox.sandboxHandle, modelEnv);
    yield* dispatchToDaemon({
      provider,
      handle: sandbox.sandboxHandle,
      harnessId: this.harnessId,
      input: {
        ...input,
        // Hosted Decopilot's in-process client ignores `mcp` and gets the
        // sentinel `{url: "", ...}`. This harness is a real MCP client in
        // another process, so it needs a real endpoint — without one the
        // daemon rejects the envelope outright, and the org's tools (moving
        // the task on the board, for one) would be unreachable anyway.
        mcp: await mintMcpEndpoint(
          this.ctx,
          this.virtualMcpId,
          organization,
          `${this.harnessId}-run`,
        ),
        // Hosted Decopilot mounts no working directory; this harness edits the
        // checkout the daemon prepared.
        workspace: await this.resolveWorkspace(input.threadId),
      },
      // The daemon keys cancellation (`DELETE /_sandbox/runs/:runId`) by this
      // id, and Studio's run identity is the thread — same key the rest of the
      // hosted pipeline uses for the run.
      runId: input.threadId,
      signal: input.signal,
    });
  }
}

/**
 * PUT the run's model env onto the daemon's config channel.
 *
 * ⚠️ SECURITY: `env` holds a model credential. Never log it, and never include
 * the request body in an error message.
 */
async function pushSandboxEnv(
  provider: SandboxProvider,
  handle: string,
  env: Record<string, string | null>,
): Promise<void> {
  const res = await provider.proxyDaemonRequest(handle, "/_sandbox/config", {
    method: "PUT",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify({ env }),
  });
  if (!res.ok) {
    // Hard failure, unlike the tool-catalog sync: without the credential the
    // harness cannot reach a model at all, so proceeding wastes a pod boot and
    // reports a confusing model error instead of this one.
    throw new Error(
      `failed to push model env to the sandbox (${res.status} ${res.statusText})`,
    );
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

async function* dispatchToDaemon(args: {
  provider: SandboxProvider;
  handle: string;
  harnessId: HarnessId;
  runId: string;
  input: HarnessStreamInput;
  signal?: AbortSignal;
}): AsyncIterable<UIMessageChunk> {
  const res = await args.provider.proxyDaemonRequest(
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
  if (!res.ok || !res.body) {
    // A non-200 here is the daemon rejecting the envelope (bad input,
    // tombstoned run, unauthorized) — it never produced a stream, so surface
    // it as a throw rather than an empty successful run.
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(
      `sandbox dispatch failed (${res.status}): ${detail.slice(0, 512)}`,
    );
  }
  // Attribute the end of the stream. A transport-level failure here arrives as
  // a bare "operation timed out" with no run, no handle and no duration on it,
  // which is indistinguishable from a model error until you go read pod logs.
  const startedAt = Date.now();
  let chunks = 0;
  try {
    for await (const chunk of readDispatchSSE(res.body, args.signal)) {
      chunks++;
      yield chunk;
    }
  } catch (err) {
    console.error("[sandbox-dispatch] stream failed", {
      runId: args.runId,
      handle: args.handle,
      chunks,
      elapsedMs: Date.now() - startedAt,
      aborted: args.signal?.aborted ?? false,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    throw err;
  }
  console.log("[sandbox-dispatch] stream done", {
    runId: args.runId,
    handle: args.handle,
    chunks,
    elapsedMs: Date.now() - startedAt,
  });
}

/**
 * Yield chunks from the daemon's dispatch SSE stream.
 *
 * `error` throws (the consumer's error path is what records a failed run) and
 * `done` ends it. A stream that ends WITHOUT `done` means the harness died
 * mid-run, which must not look like a clean finish — the daemon usually turns
 * that into an `error` event itself, but if the connection drops it cannot, so
 * this checks too.
 */
export async function* readDispatchSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<UIMessageChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let sawDone = false;
  try {
    while (!signal?.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; the daemon writes exactly one
      // `data:` line per frame plus `:`-prefixed comments.
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf("\n\n");
        const payload = frameData(frame);
        if (payload === null) continue;
        const parsed = dispatchSSEEventSchema.safeParse(payload);
        if (!parsed.success) continue;
        const event = parsed.data;
        if (event.type === "done") {
          sawDone = true;
          return;
        }
        if (event.type === "error") {
          throw new Error(`${event.code}: ${event.message}`);
        }
        yield event.chunk as UIMessageChunk;
      }
    }
    if (!sawDone && !signal?.aborted) {
      throw new Error("sandbox dispatch stream ended before done");
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** The parsed JSON of a frame's `data:` line, or null if it carries none. */
function frameData(frame: string): unknown {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice("data:".length).trim());
    } catch {
      return null;
    }
  }
  return null;
}
