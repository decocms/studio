/**
 * Unit tests for DesktopSandboxProvider.ensure().
 *
 * Verifies the probe→404→respawn contract: when the state-store has a
 * persisted record whose `probeHealth` returns a non-2xx, `ensure` must
 * delete the state-store row and dispatch exactly one POST /api/sandboxes.
 */

import { describe, expect, it } from "bun:test";
import { DesktopSandboxProvider } from "./runner";
import type { RunnerStateStoreOps } from "../state-store";
import type { SandboxId } from "../types";
import { computeHandle } from "../shared/handle";

// ---- Fake dispatch -----------------------------------------------------------
// Records calls; returns a scripted JSON response via an async generator.

type DispatchCall = { method: string; path: string; body?: string };
const RUNNER_KIND = "user-desktop";

function makeDispatch(
  responses: Map<string, { status: number; body: unknown }>,
  calls: DispatchCall[],
) {
  return async function* dispatch(
    _userSub: string,
    req: {
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: string;
    },
    _opts?: unknown,
  ) {
    calls.push({ method: req.method, path: req.path, body: req.body });
    // Responses are keyed by full `"<METHOD> <path>"`; unmatched calls
    // default to 200 {} (e.g. any incidental health probe).
    const resp = responses.get(`${req.method} ${req.path}`) ?? {
      status: 200,
      body: {},
    };
    yield {
      headers: {
        status: resp.status,
        headers: { "content-type": "application/json" },
      },
    };
    yield { data: JSON.stringify(resp.body) };
  };
}

// ---- Fake state-store --------------------------------------------------------

function makeStateStore(): RunnerStateStoreOps & {
  _rows: Map<string, { handle: string; state: Record<string, unknown> }>;
  deleteByHandleCalls: { kind: string; handle: string }[];
} {
  const rows = new Map<
    string,
    { handle: string; state: Record<string, unknown> }
  >();
  const deleteByHandleCalls: { kind: string; handle: string }[] = [];

  return {
    _rows: rows,
    deleteByHandleCalls,

    async get(_id: SandboxId, _kind: string) {
      return null;
    },
    async getByHandle(kind: string, handle: string) {
      const row = rows.get(`${kind}:${handle}`);
      if (!row) return null;
      return {
        handle: row.handle,
        state: row.state,
        updatedAt: new Date(),
        id: { userId: "u1", projectRef: "ref" },
      };
    },
    async put(
      id: SandboxId,
      kind: string,
      entry: { handle: string; state: Record<string, unknown> },
    ) {
      rows.set(`${kind}:${entry.handle}`, {
        handle: entry.handle,
        state: entry.state,
      });
    },
    async delete(_id: SandboxId, _kind: string) {},
    async deleteByHandle(kind: string, handle: string) {
      deleteByHandleCalls.push({ kind, handle });
      rows.delete(`${kind}:${handle}`);
    },
  };
}

// ---- Tests ------------------------------------------------------------------

const SANDBOX_ID: SandboxId = {
  userId: "u1",
  projectRef: "agent:org:vmcp:deco/test-branch",
};
const BRANCH = "deco/test-branch";
const HANDLE = computeHandle(SANDBOX_ID, BRANCH);
const SANDBOX_API_URL = "http://127.0.0.1:9000";
const PREVIEW_URL = "http://my-handle.localhost:8000";

describe("DesktopSandboxProvider.ensure()", () => {
  it("re-probes a persisted state-store entry and respawns when probe returns non-2xx", async () => {
    const calls: DispatchCall[] = [];

    // GET /api/sandboxes/<handle> → 404 (daemon restarted, no live sandbox)
    // POST /api/sandboxes → 200 with a new sandbox
    const responses = new Map([
      [
        `GET /api/sandboxes/${encodeURIComponent(HANDLE)}`,
        { status: 404, body: { error: "not found" } },
      ],
      [
        "POST /api/sandboxes",
        {
          status: 200,
          body: { sandboxApiUrl: SANDBOX_API_URL, previewUrl: PREVIEW_URL },
        },
      ],
    ]);

    const dispatch = makeDispatch(responses, calls);
    const stateStore = makeStateStore();

    // Seed the state-store as if a previous session had persisted a record.
    await stateStore.put(SANDBOX_ID, RUNNER_KIND, {
      handle: HANDLE,
      state: {
        handle: HANDLE,
        sandboxApiUrl: SANDBOX_API_URL,
        previewUrl: PREVIEW_URL,
      },
    });

    const provider = new DesktopSandboxProvider({
      userSub: "u1",
      dispatch: dispatch as never,
      stateStore,
    });

    const sandbox = await provider.ensure(SANDBOX_ID, {
      repo: {
        branch: BRANCH,
        cloneUrl: "",
        userName: "",
        userEmail: "",
        displayName: "",
      },
    });

    // The stale state-store row must have been deleted.
    expect(stateStore.deleteByHandleCalls).toHaveLength(1);
    expect(stateStore.deleteByHandleCalls[0]).toMatchObject({
      kind: RUNNER_KIND,
      handle: HANDLE,
    });

    // Exactly one POST /api/sandboxes must have been dispatched (respawn).
    const postCalls = calls.filter(
      (c) => c.method === "POST" && c.path === "/api/sandboxes",
    );
    expect(postCalls).toHaveLength(1);

    // The returned sandbox carries the new daemon's URLs.
    expect(sandbox.handle).toBe(HANDLE);
    expect(sandbox.previewUrl).toBe(PREVIEW_URL);
  });

  it("returns the cached entry directly when probe returns 2xx (daemon still alive)", async () => {
    const calls: DispatchCall[] = [];

    const responses = new Map([
      [
        `GET /api/sandboxes/${encodeURIComponent(HANDLE)}`,
        { status: 200, body: { status: "ready" } },
      ],
    ]);

    const dispatch = makeDispatch(responses, calls);
    const stateStore = makeStateStore();

    await stateStore.put(SANDBOX_ID, RUNNER_KIND, {
      handle: HANDLE,
      state: {
        handle: HANDLE,
        sandboxApiUrl: SANDBOX_API_URL,
        previewUrl: PREVIEW_URL,
      },
    });

    const provider = new DesktopSandboxProvider({
      userSub: "u1",
      dispatch: dispatch as never,
      stateStore,
    });

    const sandbox = await provider.ensure(SANDBOX_ID, {
      repo: {
        branch: BRANCH,
        cloneUrl: "",
        userName: "",
        userEmail: "",
        displayName: "",
      },
    });

    // State-store row must NOT have been deleted.
    expect(stateStore.deleteByHandleCalls).toHaveLength(0);

    // No POST — daemon was alive so no respawn needed.
    const postCalls = calls.filter((c) => c.method === "POST");
    expect(postCalls).toHaveLength(0);

    expect(sandbox.handle).toBe(HANDLE);
  });
});
