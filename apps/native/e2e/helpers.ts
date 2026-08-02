/**
 * Shared harness for the local-api black-box e2e suite (`apps/native/e2e/`).
 *
 * Every assertion in `*.e2e.test.ts` next to this file is a BLACK-BOX HTTP/SSE
 * contract against the native local-API contract. There is no
 * bundled fallback binary — unlike `packages/sandbox/daemon-e2e/daemon.e2e.helpers.ts`
 * (which defaults to the built Go daemon binary when `DAEMON_E2E_CMD` is
 * unset), Phase 0 ships no Rust implementation. `LOCAL_API_E2E_CMD` unset means
 * "skip this suite" — see `SKIP_NO_BINARY` / `describeLocalApi` below.
 *
 * This file imports only `node:`/`bun:` builtins and
 * `@decocms/shared/std` (a zero-dependency isomorphic module) — zero coupling
 * to any daemon or API source, so it can drive a non-TS implementation just
 * as well.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sleep } from "@decocms/shared/std";
import { describe as bunDescribe, expect } from "bun:test";

/** Per-test-run bearer. 32+ chars, matches the daemon suite's convention
 *  (`daemon.e2e.helpers.ts`'s `DAEMON_TOKEN`) so a Rust binary honoring the
 *  `DAEMON_TOKEN` alias (see the contract doc's env table) behaves identically
 *  under either harness. */
const LOCAL_API_TOKEN = "d".repeat(32);

// CI cold-start occasionally exceeds Bun's default 5s hook timeout under
// load. Each test spawns a fresh process, so give hooks generous headroom —
// mirrors HOOK_TIMEOUT_MS in daemon.e2e.helpers.ts.
export const HOOK_TIMEOUT_MS = 30_000;
const PORT_WAIT_TIMEOUT_MS = 20_000;
const PORT_POLL_INTERVAL_MS = 50;

/**
 * Resolve the command used to spawn the local-api binary under test.
 *
 * Same resolution semantics as `resolveDaemonCmd` in
 * `packages/sandbox/daemon-e2e/daemon.e2e.helpers.ts`: `LOCAL_API_E2E_CMD` is
 * either a JSON array (`'["./target/release/local-api"]'`, required when args
 * contain spaces) or a plain whitespace-separated string
 * (`"/abs/path/local-api --flag"`). Unlike the daemon resolver, there is no
 * default — returns `null` when unset so callers can skip cleanly.
 *
 * Rest-args (not a JS default parameter) on purpose: a default parameter
 * (`raw = process.env...`) substitutes its default whenever the caller's
 * argument is exactly `undefined` — including an EXPLICIT
 * `resolveLocalApiCmd(undefined)` call, which is indistinguishable from
 * "caller passed nothing." That made `helpers.test.ts`'s own
 * `resolveLocalApiCmd(undefined)` self-check ("returns null when unset")
 * silently re-read the ambient `process.env.LOCAL_API_E2E_CMD` instead of
 * actually testing the no-argument path — and fail whenever a caller (e.g.
 * this very suite's Gate C invocation) has that env var set. Capturing the
 * argument via `...args` instead makes "the caller passed one explicit
 * argument, value `undefined`" (`args.length === 1`) distinguishable from
 * "the caller passed nothing at all" (`args.length === 0`) — only the
 * latter falls back to the environment.
 */
export function resolveLocalApiCmd(
  ...args: [raw?: string | null]
): string[] | null {
  const raw = args.length > 0 ? args[0] : process.env.LOCAL_API_E2E_CMD;
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      if (parsed.length === 0) {
        throw new Error("LOCAL_API_E2E_CMD is empty");
      }
      return parsed;
    }
  } catch {
    /* not JSON — fall back to whitespace split */
  }
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 0) {
    throw new Error("LOCAL_API_E2E_CMD is empty");
  }
  return parts;
}

// Module-private (not exported) — mirrors `DAEMON_CMD` in
// `daemon.e2e.helpers.ts`, which is likewise internal-only. Only the pure
// resolver function above is part of this module's public surface (and is
// unit-tested directly in `helpers.test.ts`).
const LOCAL_API_CMD = resolveLocalApiCmd();

/** True when no binary is configured. Every suite in this directory reads
 *  this once (via `describeLocalApi`) to skip cleanly, so `bun test` stays
 *  green repo-wide until Phase 1 lands the Rust `local-api` binary. */
const SKIP_NO_BINARY = LOCAL_API_CMD === null;

if (SKIP_NO_BINARY) {
  // Printed once at module load (bun:test imports this file once per worker),
  // loud enough to explain a silent "0 tests ran" without digging through the
  // repo. Kept as plain console output (not a test assertion) so it prints
  // even in `--reporter=dot`/CI-quiet modes.
  console.log(`
================================================================================
apps/native/e2e: LOCAL_API_E2E_CMD is not set — SKIPPING the local-api
black-box contract suite.

This suite exercises the Rust local-api binary described in
the native local-API contract. There is no bundled fallback (no
Rust implementation exists yet — see the desktop migration contract
Phase 1). To run it against a build:

  LOCAL_API_E2E_CMD='["/path/to/local-api"]' bun test apps/native/e2e

or a plain whitespace-separated command string:

  LOCAL_API_E2E_CMD="/path/to/local-api" bun test apps/native/e2e
================================================================================
`);
}

/**
 * `describe` that skips its whole body when no binary is configured —
 * `describe.skipIf` still registers the suite's `beforeAll`/`it` blocks (as
 * skipped), which is exactly what we want: green, visibly-skipped tests
 * rather than a bare early `return` that would hide the suite from `bun
 * test`'s output entirely.
 */
export const describeLocalApi = bunDescribe.skipIf(SKIP_NO_BINARY);

export interface LocalApi {
  port: number;
  /** The dedicated PREVIEW listener's port — see `local_api::ServerHandle`'s
   *  doc comment (the port-router split: this listener serves ONLY the
   *  reverse-proxy-to-dev-server fallback, no auth). ALWAYS ephemeral —
   *  discovered from the `LOCAL_API_PREVIEW_PORT=` stdout line (unlike
   *  `port` above, which this harness pre-picks via `freePort()` and passes
   *  in via `LOCAL_API_PORT`). */
  previewPort: number;
  proc: ChildProcess;
  workdir: string;
  /** Captured stderr, for surfacing startup crashes in assertions. */
  stderr: { value: string };
}

export function authHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { Authorization: `Bearer ${LOCAL_API_TOKEN}`, ...extra };
}

export function jsonAuthHeaders(): Record<string, string> {
  return authHeaders({ "Content-Type": "application/json" });
}

/** Absolute URL for a path on the local-api instance's MAIN listener under
 *  test (the app's own API — health/_sandbox/threads/models/app-API
 *  fallback). */
export function url(a: LocalApi, path: string): string {
  return `http://127.0.0.1:${a.port}${path}`;
}

/** Absolute URL for a path on the local-api instance's PREVIEW listener —
 *  the dev-server reverse-proxy fallback, a genuinely separate port/origin
 *  from `url()` above (see `local_api::ServerHandle`'s doc comment). No
 *  bearer is ever needed against this listener. */
export function previewUrl(a: LocalApi, path: string): string {
  return `http://localhost:${a.previewPort}${path}`;
}

/**
 * Ask the OS for a free port via a transient bind on port 0 — far less flaky
 * than picking a random number in a fixed range. Mirrors `freePort` in
 * `daemon.e2e.helpers.ts`. Module-private for now (only `startLocalApi` below
 * calls it) — export it if/when a future suite needs to mint a port itself
 * (e.g. a mock upstream server for the app-API proxy).
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr && typeof addr.port === "number") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("freePort: bad address")));
      }
    });
  });
}

async function waitForPort(
  port: number,
  proc: ChildProcess,
  stderrBuf: { value: string },
  timeoutMs = PORT_WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `local-api exited before /health responded (code=${proc.exitCode} signal=${proc.signalCode}) stderr=${stderrBuf.value.slice(-2000)}`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(PORT_POLL_INTERVAL_MS);
  }
  throw new Error(`local-api did not listen on :${port} within ${timeoutMs}ms`);
}

/**
 * Unlike `port` (pre-picked by this harness via `freePort()` and passed in
 * via `LOCAL_API_PORT`), the preview listener always binds an EPHEMERAL
 * port — the only way to learn it is `boot_from_env`'s
 * `LOCAL_API_PREVIEW_PORT=<port>` stdout line (see `lib.rs`). Polls the
 * accumulated stdout buffer rather than a fixed one-shot read: the child's
 * stdout pipe is delivered async, so this line may not have arrived yet
 * even though `waitForPort` above already confirmed `/health` responds.
 */
async function waitForPreviewPort(
  stdoutBuf: { value: string },
  proc: ChildProcess,
  timeoutMs = PORT_WAIT_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = stdoutBuf.value.match(/LOCAL_API_PREVIEW_PORT=(\d+)/);
    if (match) return Number(match[1]);
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(
        `local-api exited before printing LOCAL_API_PREVIEW_PORT= (code=${proc.exitCode} signal=${proc.signalCode})`,
      );
    }
    await sleep(PORT_POLL_INTERVAL_MS);
  }
  throw new Error(
    `local-api never printed LOCAL_API_PREVIEW_PORT= within ${timeoutMs}ms; stdout=${stdoutBuf.value.slice(-2000)}`,
  );
}

/**
 * Spawn the local-api binary under test. Honors the canonical env contract
 * from the native local-API contract (`LOCAL_API_TOKEN` /
 * `LOCAL_API_PORT` / `LOCAL_API_WORKDIR` / `LOCAL_API_BOOT_ID`) — a Phase 1
 * implementation that only understands the legacy `DAEMON_*` aliases still
 * boots (this suite doesn't rely on the aliases; `daemon.e2e.helpers.ts`
 * covers that side of the contract), but the canonical names are what this
 * suite is pinning.
 *
 * `opts.workdir`: reuse an EXISTING directory as `LOCAL_API_WORKDIR` instead
 * of minting a fresh one — the seam a "restart local-api against the same
 * workdir" test needs (a real backend restart: same on-disk sandbox
 * workdirs/logs/sidecars, a brand-new in-memory process). Pair with
 * `stopLocalApi(a, { keepWorkdir: true })` so the directory survives the
 * kill between two `startLocalApi` calls.
 *
 * `opts.tokenStore`: memory by default. Persistence-specific macOS tests may
 * opt into a unique disposable Keychain service; callers cannot select a
 * credential store through `extraEnv`.
 */
export async function startLocalApi(
  extraEnv: Record<string, string> = {},
  opts: {
    workdir?: string;
    tokenStore?: { kind: "memory" } | { kind: "keychain"; service: string };
  } = {},
): Promise<LocalApi> {
  if (!LOCAL_API_CMD) {
    throw new Error(
      "startLocalApi() called without LOCAL_API_E2E_CMD set — this should be unreachable behind describeLocalApi/SKIP_NO_BINARY",
    );
  }
  const workdir = opts.workdir ?? mkdtempSync(join(tmpdir(), "local-api-e2e-"));
  const port = await freePort();
  const [cmd, ...args] = LOCAL_API_CMD;
  const tokenStore = opts.tokenStore ?? { kind: "memory" as const };
  const proc = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      LOCAL_API_TOKEN,
      LOCAL_API_BOOT_ID: `boot-${port}`,
      LOCAL_API_WORKDIR: workdir,
      LOCAL_API_PORT: String(port),
      ...extraEnv,
      // Black-box suites default to memory and cannot override this through
      // `extraEnv`. Persistence-specific macOS tests opt into a unique,
      // disposable Keychain service explicitly through `opts.tokenStore`.
      LOCAL_API_TOKEN_STORE: tokenStore.kind,
      ...(tokenStore.kind === "keychain"
        ? { LOCAL_API_KEYRING_SERVICE: tokenStore.service }
        : {}),
    },
  });
  const stderr = { value: "" };
  const stdout = { value: "" };
  proc.stdout?.on("data", (c) => {
    stdout.value += c.toString();
    process.stderr.write(`[local-api:out] ${c}`);
  });
  proc.stderr?.on("data", (c) => {
    stderr.value += c.toString();
    process.stderr.write(`[local-api:err] ${c}`);
  });
  await waitForPort(port, proc, stderr);
  const previewPort = await waitForPreviewPort(stdout, proc);
  return { port, previewPort, proc, workdir, stderr };
}

/**
 * `opts.keepWorkdir`: skip the `rmSync` cleanup — for a "restart against the
 * same workdir" test that still has a second `startLocalApi({}, { workdir })`
 * call ahead of it. The caller is responsible for cleaning the directory up
 * itself once truly done (see `sandbox-restart-resurrection.e2e.test.ts`).
 */
export async function stopLocalApi(
  a: LocalApi | null,
  opts: { keepWorkdir?: boolean } = {},
): Promise<void> {
  if (!a) return;
  const { proc, workdir } = a;
  if (proc.exitCode === null && proc.signalCode === null) {
    // Wait for the OS to reap the process so its bound port is released
    // before the next startLocalApi picks a fresh one.
    await new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      proc.kill("SIGKILL");
    });
  }
  if (workdir && !opts.keepWorkdir)
    rmSync(workdir, { recursive: true, force: true });
}

// --- SSE ---------------------------------------------------------------------

/**
 * Read an SSE stream until `predicate(accumulated)` is true, then abort.
 * Hard-bounded by a deadline timer that aborts the request — so even a stream
 * that emits no bytes and never closes fails loudly within `deadlineMs`
 * instead of stalling until Bun's global timeout. Accumulates across chunks
 * (event boundaries split arbitrarily). Ported verbatim (behaviorally) from
 * `daemon.e2e.helpers.ts::readSseUntil`.
 */
export async function readSseUntil(
  target: string,
  opts: {
    predicate: (acc: string) => boolean;
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    deadlineMs?: number;
  },
): Promise<{ res: Response; text: string }> {
  const deadlineMs = opts.deadlineMs ?? 8000;
  const ctrl = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let acc = "";
  let matched: Response | undefined;

  // Race the WHOLE operation (fetch + every read) against one deadline.
  // Aborting the fetch signal does NOT reliably reject an in-flight
  // `reader.read()` (nor a header-stalled `fetch`) in Bun, so the race — not
  // the abort — is what bounds a stream that emits nothing and never closes.
  const work = (async () => {
    const res = await fetch(target, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: ctrl.signal,
    });
    reader = res.body!.getReader();
    const dec = new TextDecoder();
    while (true) {
      const r = await reader.read();
      if (r.done) return;
      acc += dec.decode(r.value, { stream: true });
      if (opts.predicate(acc)) {
        matched = res;
        return;
      }
    }
  })();
  // The leaked read rejects once we abort/cancel below — swallow it so it
  // never surfaces as an unhandled rejection after we've already timed out.
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMEOUT"), deadlineMs);
  });

  try {
    const outcome = await Promise.race([
      work.then(() => "DONE" as const),
      timeout,
    ]);
    if (outcome === "TIMEOUT") {
      throw new Error(
        `SSE stream did not match within ${deadlineMs}ms; last 500 chars:\n${acc.slice(-500)}`,
      );
    }
    if (matched) return { res: matched, text: acc };
    throw new Error(
      `SSE stream ended before predicate matched; last 500 chars:\n${acc.slice(-500)}`,
    );
  } finally {
    if (timer) clearTimeout(timer);
    ctrl.abort();
    try {
      await reader?.cancel();
    } catch {
      /* already closed */
    }
  }
}

// --- Threads convenience -----------------------------------------------------

export interface ThreadWire {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** POST /threads — returns the created thread. Throws on non-201. */
export async function createThread(
  a: LocalApi,
  title?: string,
): Promise<ThreadWire> {
  const res = await fetch(url(a, "/threads"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(title === undefined ? {} : { title }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { thread: ThreadWire };
  return body.thread;
}

export interface RunWire {
  id: string;
  thread_id: string;
  harness_id: "claude-code" | "codex";
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  created_at: string;
  ended_at: string | null;
  error: string | null;
}

/** GET /threads/:id/runs — returns the run list. Throws on non-200. */
export async function listRuns(
  a: LocalApi,
  threadId: string,
): Promise<RunWire[]> {
  const res = await fetch(url(a, `/threads/${threadId}/runs`), {
    headers: jsonAuthHeaders(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { runs: RunWire[] };
  return body.runs;
}

export interface MessageWire {
  id: string;
  thread_id: string;
  role: "user" | "assistant" | "system";
  parts: unknown[];
  created_at: string;
}

/** GET /threads/:id/messages — returns the message list. Throws on non-200. */
export async function listMessages(
  a: LocalApi,
  threadId: string,
): Promise<MessageWire[]> {
  const res = await fetch(url(a, `/threads/${threadId}/messages`), {
    headers: jsonAuthHeaders(),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { messages: MessageWire[] };
  return body.messages;
}

// --- Harness dispatch convenience --------------------------------------------

/**
 * Absolute path to the deterministic fake `claude` CLI
 * (`apps/native/e2e/fixtures/stub-harness.mjs`) — see that file's header
 * comment for the full wire-format spec (flags accepted, ndjson event
 * shapes per scenario).
 */
export const STUB_HARNESS_PATH = fileURLToPath(
  new URL("./fixtures/stub-harness.mjs", import.meta.url),
);

/**
 * `extraEnv` fragment for `startLocalApi()` that points the SHARED CONTRACT
 * env override (`LOCAL_API_CLAUDE_BIN`, `apps/native/docs/
 * the native local-API contract`'s env contract section) at the stub harness,
 * invoked explicitly via `node` (JSON-array form) so this works regardless
 * of the checked-out file's execute bit. Optionally overrides
 * `STUB_HARNESS_SLOW_MS`/`STUB_HARNESS_VERSION` for the spawned stub itself
 * (forwarded to the child's env, NOT consumed by local-api).
 */
export function stubClaudeBinEnv(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    LOCAL_API_CLAUDE_BIN: JSON.stringify(["node", STUB_HARNESS_PATH]),
    ...extra,
  };
}

/**
 * Builds a `harnessStreamInputSchema`-conforming `input` payload (see
 * `packages/sandbox/dispatch/schemas.ts` — read-only reference, never
 * imported directly per this suite's zero-coupling-to-daemon-source rule,
 * see this file's top-of-file doc comment) for `POST /_sandbox/dispatch`.
 * `prompt` is embedded in `userMessage.parts[0].text` — the stub harness
 * greps its own argv/stdin for a `SCENARIO:<name>` tag anywhere, so exactly
 * how the harness crate threads this text into the CLI invocation doesn't
 * matter for scenario selection to work.
 */
export function buildDispatchInput(opts: {
  threadId: string;
  prompt: string;
}): Record<string, unknown> {
  return {
    threadId: opts.threadId,
    userMessage: {
      role: "user",
      parts: [{ type: "text", text: opts.prompt }],
    },
    harness: {},
    workspace: { cwd: null },
    models: {
      thinking: {
        id: "claude-code:sonnet",
        title: "Sonnet",
        credentialId: "stub-cred",
      },
    },
    mcp: {
      url: "http://127.0.0.1:1/mcp",
      headers: {},
      expiresAt: Date.now() + 60_000,
    },
    mode: "default",
    temperature: 0,
    toolApprovalLevel: "auto",
    user: { id: "stub-user", email: "stub@example.com" },
    organizationId: "stub-org",
    agent: { id: "stub-agent" },
  };
}

/**
 * One parsed `POST /_sandbox/dispatch` SSE frame. Mirrors
 * `DispatchSSEEvent` from `packages/sandbox/dispatch/schemas.ts` structurally
 * (this suite doesn't import that module — see the zero-coupling note above
 * — so the shape is duplicated here deliberately; a divergence is a
 * wire-contract regression signal, exactly the tradeoff
 * `packages/e2e`'s black-box rule documents for its own suite, see
 * CLAUDE.md's "E2E isolation" section).
 */
export type DispatchFrame =
  | { type: "ui-message-chunk"; chunk: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "done" };

/**
 * Parses accumulated SSE text from `POST /_sandbox/dispatch` into ordered
 * `DispatchFrame`s. Per the native local-API contract, dispatch's
 * framing is DATA-ONLY (no `event:` line — default event name `message`
 * applies) with one leading `: dispatch accepted` comment line before the
 * first data frame. Comment lines (`:...`) and blank lines are skipped;
 * every remaining `data: <json>` line is JSON-parsed in order.
 */
export function parseDispatchFrames(sseText: string): DispatchFrame[] {
  const frames: DispatchFrame[] = [];
  for (const rawLine of sseText.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    if (line.startsWith(":")) continue; // SSE comment (e.g. "dispatch accepted")
    if (!line.startsWith("data:")) continue;
    const jsonText = line.slice("data:".length).trimStart();
    frames.push(JSON.parse(jsonText) as DispatchFrame);
  }
  return frames;
}

/**
 * Runs a full `POST /_sandbox/dispatch` request to completion (reads until
 * a `{"type":"done"}` frame lands, per the contract's "always emitted
 * exactly once, last event before the stream closes" guarantee — including
 * after an error or a client-initiated cancel), returning the parsed
 * frames plus the raw response for header assertions.
 */
export async function runDispatchToCompletion(
  a: LocalApi,
  body: unknown,
  opts: { deadlineMs?: number } = {},
): Promise<{ res: Response; frames: DispatchFrame[]; rawText: string }> {
  const { res, text } = await readSseUntil(url(a, "/_sandbox/dispatch"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
    predicate: (acc) => acc.includes('"type":"done"'),
    deadlineMs: opts.deadlineMs ?? 8000,
  });
  return { res, frames: parseDispatchFrames(text), rawText: text };
}
