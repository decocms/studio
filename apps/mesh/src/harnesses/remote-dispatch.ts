/**
 * Remote Dispatch.
 *
 * The cluster-side counterpart to `localDispatch` for runs that resolve
 * to a `remote-cli` target — the entire harness stream is delegated to
 * the user's link daemon over the registered tunnel URL. The cluster
 * keeps producing UI chunks back to the chat client by tailing the
 * daemon's SSE response and re-emitting `UIMessageChunk`s.
 *
 * Wire shape (per `harnessStreamInputSchema.strip()`): non-serializable
 * fields (`signal`, `processLocal`) are stripped before signing. The
 * body is `{ harnessId, input: wireInput }` JSON; HMAC headers
 * authenticate (no Bearer header — sending the signing key plaintext in
 * a header would defeat the point of HMAC, see Task 5.1).
 *
 * URL: `<sandboxUrl>/_decopilot_vm/dispatch` — the per-daemon tunnel URL
 * (`https://<handle>.deco.host` in prod, `http://127.0.0.1:<port>` in dev
 * `--no-tunnel`) returned by the link's `POST /api/sandboxes`. The cluster
 * talks to the daemon directly; the link no longer reverse-proxies
 * `/_sandbox/<handle>/*` (that route was deleted with the per-daemon-tunnel
 * migration).
 *
 * Handle vs runId: for remote-cli (whole-harness dispatch), the desktop
 * spins up an ephemeral per-run sandbox; the handle == `input.runId`.
 * This differs from the desktop provider path (Task 5.1), where the
 * handle is `computeHandle(sandboxId, branch)` because the sandbox is
 * long-lived and shared across runs. The daemon's cancel route
 * (`/_decopilot_vm/runs/<runId>`) confirms this — it matches on runId
 * directly.
 *
 * Cancellation: on consumer abort, fires a DELETE to the runs endpoint
 * independent of SSE close so the desktop can abort its CLI subprocess
 * promptly even if the response stream is still draining.
 */
import type { UIMessageChunk } from "ai";
import {
  signRequest,
  dispatchSSEEventSchema,
  type LinkEntry,
} from "../links/protocol";
import type { HarnessId, HarnessStreamInput } from "./types";

/**
 * Parse the daemon's SSE response into a stream of UIMessageChunks.
 *
 * Buffers incoming bytes, splits on the `\n\n` event boundary, and
 * decodes each event from one or more `data: …` lines (joined by
 * `\n`). Events are validated through `dispatchSSEEventSchema`:
 *
 *   - `ui-message-chunk` → yields the chunk
 *   - `error`            → throws (carrying code + message)
 *   - `done`             → returns
 *   - anything else      → silently skipped (forward-compat)
 *
 * Unparseable JSON or schema-mismatched events are also skipped — the
 * parser is permissive on purpose. The daemon controls both ends of the
 * wire, so the failure mode that matters is a future protocol bump
 * adding a new event type; we don't want old clients to crash.
 */
export async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<UIMessageChunk> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        // Flush any trailing bytes that didn't include the final \n\n.
        // Standards-compliant SSE producers always end with the
        // separator, but we'd rather be lenient than drop a final event
        // on a chunk boundary.
        buffer += decoder.decode();
        const trailing = buffer.trim();
        if (trailing.length > 0) {
          for (const ev of extractEvents(trailing + "\n\n")) {
            yield* handleEvent(ev);
          }
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const eventBlock = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);
        separatorIndex = buffer.indexOf("\n\n");

        for (const ev of extractEvents(eventBlock + "\n\n")) {
          yield* handleEvent(ev);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Split a single SSE event block into `data:`-only payloads. One event
 * may carry multiple `data:` lines — per the SSE spec they get joined
 * with `\n` to form the final payload. Other line types (`event:`,
 * `id:`, comments starting with `:`) are ignored because the daemon
 * doesn't emit them today.
 */
function extractEvents(block: string): string[] {
  const events: string[] = [];
  const dataLines = block
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length));
  if (dataLines.length > 0) {
    events.push(dataLines.join("\n"));
  }
  return events;
}

async function* handleEvent(dataJson: string): AsyncIterable<UIMessageChunk> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(dataJson);
  } catch {
    return; // ignore garbage
  }
  const parsed = dispatchSSEEventSchema.safeParse(parsedJson);
  if (!parsed.success) return; // ignore unknown event shapes (forward-compat)

  if (parsed.data.type === "ui-message-chunk") {
    yield parsed.data.chunk as UIMessageChunk;
  } else if (parsed.data.type === "error") {
    throw new Error(
      `[remoteDispatch] ${parsed.data.code}: ${parsed.data.message}`,
    );
  } else if (parsed.data.type === "done") {
    // Signal end of stream by returning. The caller's for-await loop
    // breaks when the generator returns.
    return;
  }
}

export interface RemoteDispatchDeps {
  fetchImpl?: typeof fetch;
}

/**
 * Subset of `LinkEntry` actually needed by `remoteDispatch`. Accepting
 * the smaller shape makes test fakes cheaper to construct.
 */
export type RemoteDispatchLink = Pick<LinkEntry, "tunnelUrl" | "linkSecret">;

/**
 * Ensure the desktop link has a sandbox registered at `handle` before the
 * cluster fires `remoteDispatch`. The link's `POST /api/sandboxes`
 * spawns (or reuses) a daemon for `handle` and returns the daemon's
 * `sandboxUrl` — a per-daemon tunnel (`https://<handle>.deco.host` in
 * prod, `http://127.0.0.1:<port>` in dev `--no-tunnel`). The cluster
 * then talks to the daemon DIRECTLY at that URL; the link no longer
 * reverse-proxies `/_sandbox/<handle>/*` (that route was deleted with
 * the per-daemon-tunnel migration).
 *
 * Used by `remote-cli` dispatch where the handle equals `input.runId` —
 * a fresh, ephemeral per-run sandbox. We do NOT go through the
 * `desktop` SandboxProvider here because that provider derives its
 * handle via `computeHandle(sandboxId, branch)`, which would diverge
 * from the runId-keyed flow `remoteDispatch` uses.
 *
 * No `repo` is sent: ephemeral CLI runs operate on an empty workdir
 * the link auto-creates at `<dataDir>/link/sandboxes/<handle>/`.
 *
 * Idempotent on the link side — repeated POSTs with the same handle
 * return the existing sandbox unchanged.
 */
export async function ensureRemoteCliSandbox(
  link: RemoteDispatchLink,
  handle: string,
  deps: RemoteDispatchDeps = {},
): Promise<{ sandboxUrl: string }> {
  const fetcher = deps.fetchImpl ?? fetch;
  const path = "/api/sandboxes";
  const body = JSON.stringify({ handle });
  const sigHeaders = signRequest({
    secret: link.linkSecret,
    method: "POST",
    path,
    body,
  });
  const res = await fetcher(`${link.tunnelUrl}${path}`, {
    method: "POST",
    body,
    headers: {
      ...sigHeaders,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const text = await res.text();
      detail = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    } catch {
      // ignore
    }
    throw new Error(
      `ensureRemoteCliSandbox HTTP ${res.status}${detail ? ` ${detail}` : ""}`,
    );
  }
  const parsed = (await res.json()) as { sandboxUrl?: unknown };
  if (typeof parsed.sandboxUrl !== "string") {
    throw new Error(
      "ensureRemoteCliSandbox: link did not return a sandboxUrl string",
    );
  }
  return { sandboxUrl: parsed.sandboxUrl };
}

export function remoteDispatch(
  id: HarnessId,
  input: HarnessStreamInput,
  link: RemoteDispatchLink,
  sandboxUrl: string,
  deps: RemoteDispatchDeps = {},
): AsyncIterable<UIMessageChunk> {
  const fetcher = deps.fetchImpl ?? fetch;
  // The cluster talks to the daemon directly via its per-handle tunnel
  // URL — no more link reverse-proxy hop. `link.linkSecret` is still the
  // HMAC signing key (the daemon shares it via DAEMON_LINK_SECRET, Task 1).
  // HMAC signs against the URL's pathname only (not the full URL); the
  // daemon verifies against `url.pathname` on its end.
  const dispatchTarget = `${sandboxUrl}/_decopilot_vm/dispatch`;
  const cancelTarget = `${sandboxUrl}/_decopilot_vm/runs/${input.runId}`;
  const dispatchPath = new URL(dispatchTarget).pathname;
  const cancelPath = new URL(cancelTarget).pathname;

  // Strip the two non-serializable fields. `harnessStreamInputSchema`
  // uses `.strip()` so the daemon-side parser would drop these anyway,
  // but stripping client-side keeps the body deterministic for HMAC
  // signing (otherwise an `AbortSignal` would crash JSON.stringify).
  const { signal, processLocal: _processLocal, ...wireInput } = input;

  return {
    async *[Symbol.asyncIterator]() {
      const bodyString = JSON.stringify({ harnessId: id, input: wireInput });
      const sigHeaders = signRequest({
        secret: link.linkSecret,
        method: "POST",
        path: dispatchPath,
        body: bodyString,
      });
      const res = await fetcher(dispatchTarget, {
        method: "POST",
        body: bodyString,
        headers: {
          ...sigHeaders,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(
          `remoteDispatch HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
        );
      }

      try {
        yield* parseSSEStream(res.body);
      } finally {
        // Fire a cancel RPC on consumer abort so the daemon can abort
        // its CLI subprocess promptly (independent of SSE close).
        // Best-effort: we don't await the response, and we swallow
        // errors — by the time we're in `finally` the consumer has
        // already moved on.
        if (signal?.aborted) {
          const cancelSig = signRequest({
            secret: link.linkSecret,
            method: "DELETE",
            path: cancelPath,
            body: "",
          });
          fetcher(cancelTarget, {
            method: "DELETE",
            headers: { ...cancelSig },
          }).catch(() => {});
        }
      }
    },
  };
}
