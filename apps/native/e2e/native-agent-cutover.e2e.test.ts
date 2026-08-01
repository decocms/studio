/**
 * Black-box contract for the native terminal-agent cutover.
 *
 * The hosted Decopilot request/stream/queue protocol must never be reachable
 * through local-api after the native UI switches to one persistent PTY per
 * chat. A fresh native chat instead exposes terminal metadata with no selected
 * harness so the UI can render the Claude Code / Codex picker.
 */
import { afterAll, beforeAll, expect, it } from "bun:test";

import {
  signInAndCompleteSession,
  startAuthenticatedUpstream,
} from "./authenticated-upstream";
import {
  authHeaders,
  describeLocalApi,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  type LocalApi,
  startLocalApi,
  stopLocalApi,
  url,
} from "./helpers";

const ORG = "terminal-cutover-org";
const THREAD_ID = "terminal-cutover-thread";

describeLocalApi("native terminal-agent cutover", () => {
  let api: LocalApi;
  let upstream: ReturnType<typeof startAuthenticatedUpstream>;

  beforeAll(async () => {
    upstream = startAuthenticatedUpstream();
    api = await startLocalApi({
      DECOCMS_UPSTREAM_URL: upstream.url,
      LOCAL_API_TOKEN_STORE: "memory",
      LOCAL_API_CLAUDE_BIN: JSON.stringify([
        "/bin/sh",
        "-c",
        "printf '2.1.217 (Claude Code)\\n'",
      ]),
    });
    await signInAndCompleteSession(api);

    const created = await fetch(
      url(api, `/api/${ORG}/tools/COLLECTION_THREADS_CREATE`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({
          data: {
            id: THREAD_ID,
            title: "",
            virtual_mcp_id: "terminal-cutover-agent",
          },
        }),
      },
    );
    expect(created.status).toBe(200);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await stopLocalApi(api);
    upstream.server.stop(true);
  }, HOOK_TIMEOUT_MS);

  it("exposes an unselected terminal for the fresh-chat agent picker", async () => {
    const response = await fetch(
      url(api, `/api/${ORG}/threads/${THREAD_ID}/terminal`),
      { headers: authHeaders() },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessionId: null,
      generation: expect.any(String),
      harnessId: null,
      physicalState: "exited",
      logicalState: "completed",
      threadStatus: "completed",
      lastSeq: 0,
      providerSessionAvailable: false,
    });
  });

  it("rejects malformed terminal launch choices before spawning a process", async () => {
    const response = await fetch(
      url(api, `/api/${ORG}/threads/${THREAD_ID}/terminal`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ harnessId: "not-an-agent" }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "harnessId must be claude-code, codex, or opencode",
    });
  });

  it("rejects an unsupported CLI before pinning the fresh chat", async () => {
    const response = await fetch(
      url(api, `/api/${ORG}/threads/${THREAD_ID}/terminal`),
      {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify({ harnessId: "claude-code" }),
      },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: expect.stringContaining(
        "Claude Code 2.1.217 is unsupported; Studio Native requires Claude Code 2.1.218 or newer",
      ),
    });

    const metadata = await fetch(
      url(api, `/api/${ORG}/threads/${THREAD_ID}/terminal`),
      { headers: authHeaders() },
    );
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({
      sessionId: null,
      harnessId: null,
    });
  });

  it("tombstones every legacy native Decopilot route instead of proxying it", async () => {
    const cases = [
      ["POST", `/api/${ORG}/decopilot/threads/${THREAD_ID}/messages`],
      ["GET", `/api/${ORG}/decopilot/threads/${THREAD_ID}/stream`],
      ["POST", `/api/${ORG}/decopilot/cancel/${THREAD_ID}`],
      ["GET", `/api/${ORG}/decopilot/queue/${THREAD_ID}`],
      ["POST", `/api/${ORG}/decopilot/queue/${THREAD_ID}/cancel/workflow`],
      ["GET", `/api/${ORG}/decopilot/a-future-route`],
    ] as const;

    for (const [method, path] of cases) {
      const response = await fetch(url(api, path), {
        method,
        headers: method === "POST" ? jsonAuthHeaders() : authHeaders(),
        body: method === "POST" ? "{}" : undefined,
      });
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "native_chat_removed" });
    }
  });
});
