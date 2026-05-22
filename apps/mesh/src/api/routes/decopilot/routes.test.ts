/**
 * Tests for Decopilot route helpers + POST /messages dispatch-target
 * resolution.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { MeshContext } from "@/core/mesh-context";
import type { Capability } from "@/links/protocol";
import { createInMemoryLinkRegistry } from "../../../links/link-registry";
import { computeIdempotencyKey } from "./routes";
import type { ChatMessage } from "./types";

describe("computeIdempotencyKey", () => {
  test("returns undefined for no message", () => {
    expect(computeIdempotencyKey(undefined)).toBeUndefined();
  });

  test("user turn: returns the message id verbatim", () => {
    const msg = {
      id: "user-123",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(msg)).toBe("user-123");
  });

  test("assistant continuation: hashes the message contents", () => {
    const msg = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    const key = computeIdempotencyKey(msg);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  test("identical assistant messages produce the same hash (retry safety)", () => {
    const msg = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(msg)).toBe(computeIdempotencyKey(msg)!);
  });

  test("different approval states on the same message id produce different hashes", () => {
    // Regression: the previous implementation used `lastMsg.id` for both
    // branches, so two distinct approval rounds on the same assistant
    // message collapsed onto the first workflow and bricked the chat.
    const base = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    const next = {
      ...base,
      parts: [
        ...base.parts,
        {
          type: "tool-write",
          state: "approval-responded",
          approval: { id: "ap_2", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey(next));
  });

  test("user message without id falls back to content hash", () => {
    const msg = {
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as ChatMessage;
    const key = computeIdempotencyKey(msg);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ============================================================================
// POST /:org/decopilot/threads/:threadId/messages — VM-based dispatch
// ============================================================================
//
// Bun's mock.module is module-global within a shard. Register stubs for
// `resolveTier`, `model-permissions`, `dispatch-queue`, `ensureSandbox`
// and Hono helpers BEFORE importing routes so the route module captures the
// mocked implementations. Other tests in this file don't import the route
// factory, so the mocks don't bleed into them.

mock.module("@/core/resolve-tier", () => ({
  resolveTier: async () => ({
    credentialId: "cred_local",
    modelId: "claude-3-5-sonnet",
    modelMeta: { title: "Claude 3.5 Sonnet", capabilities: [], limits: null },
  }),
  TierUnavailableError: class TierUnavailableError extends Error {},
}));

mock.module("./model-permissions", () => ({
  fetchModelPermissions: async () => undefined, // no restriction
  checkModelPermission: () => true,
  parseModelsToMap: () => ({}),
}));

mock.module("@/dispatch-queue", () => ({
  enqueueThreadRun: async () => ({ workflowID: "wf_test" }),
}));

// `./helpers` is mocked minimally — only `ensureOrganization` is exercised
// on the 409 path, and the real one already works against our stub context.
// We do NOT mock the module, to keep the rest of the imports intact.

// The POST handler resolves the sandbox provider kind to feed
// `resolveDispatchTarget` and to persist on the thread row, but no longer
// eagerly provisions a sandbox — that happens lazily inside the built-in
// tools layer on the first VM-tool call. We only need to stub the kind
// resolver; each test pins it via the module-level `vmKindForTest`.
type VmKind = "local-docker" | "cluster" | "user-desktop";
let vmKindForTest: VmKind = "local-docker";

mock.module("@/sandbox/resolve-default-provider-kind", () => ({
  resolveDefaultSandboxProviderKind: async () => vmKindForTest,
}));

const { createDecopilotRoutes } = await import("./routes");

const THREAD_ID = "thread_test_1";
const AGENT_ID = "agent_1";
const BRANCH = "main";

function buildApp(opts: {
  vmKind: VmKind;
  linkOnline: boolean;
  linkCapabilities?: Capability[];
  userId?: string;
  /**
   * Controls what the `threads.get` stub returns for (sandbox_provider_kind,
   * harness_id). Defaults to already-pinned values so existing "VM-based
   * dispatch" tests continue to act like subsequent messages. Pass both as
   * null to simulate a first-message scenario where no pins have been
   * persisted yet.
   */
  threadPins?: {
    sandbox_provider_kind?: string | null;
    harness_id?: string | null;
  };
}) {
  vmKindForTest = opts.vmKind;

  const resolvedPins = opts.threadPins ?? {
    sandbox_provider_kind: opts.vmKind,
    harness_id: "claude-code",
  };

  const linkRegistry = createInMemoryLinkRegistry({
    nowSeconds: () => Math.floor(Date.now() / 1000),
  });

  const threadUpdateSpy = mock(async () => {});

  const ctx = {
    organization: { id: "org_1", slug: "org_1" },
    auth: { user: { id: opts.userId ?? "user_1" } },
    storage: {
      aiProviderKeys: {
        findById: mock(async () => ({
          id: "cred_local",
          providerId: "claude-code",
        })),
      },
      threads: {
        get: mock(async () => ({
          id: THREAD_ID,
          branch: BRANCH,
          sandbox_provider_kind: resolvedPins.sandbox_provider_kind ?? null,
          harness_id: resolvedPins.harness_id ?? null,
        })),
        update: threadUpdateSpy,
      },
      virtualMcps: {
        findById: mock(async () => ({
          id: AGENT_ID,
          organization_id: "org_1",
          metadata: {
            sandboxMap: {
              user_1: {
                [BRANCH]: {
                  sandboxHandle: "vm_test",
                  previewUrl: null,
                  sandboxProviderKind: opts.vmKind,
                },
              },
            },
          },
        })),
      },
    },
    linkRegistry,
    db: {} as MeshContext["db"],
  } as unknown as MeshContext;

  const app = new Hono<{ Variables: { meshContext: MeshContext } }>();
  app.use("*", async (c, next) => {
    c.set("meshContext", ctx);
    await next();
  });
  app.route(
    "/api",
    createDecopilotRoutes({
      cancelBroadcast: {
        start: async () => {},
        broadcast: () => {},
        stop: async () => {},
      } as unknown as Parameters<
        typeof createDecopilotRoutes
      >[0]["cancelBroadcast"],
      streamBuffer: {} as Parameters<
        typeof createDecopilotRoutes
      >[0]["streamBuffer"],
      runRegistry: {} as Parameters<
        typeof createDecopilotRoutes
      >[0]["runRegistry"],
      linkRegistry,
    }),
  );

  // Populate the link registry if the test scenario requires an online link.
  const seedLink = async () => {
    if (opts.linkOnline) {
      await linkRegistry.put(opts.userId ?? "user_1", {
        machineId: "m1",
        cliVersion: "1.0.0",
        protocolVersion: 1,
        capabilities:
          opts.linkCapabilities ?? (["claude-code"] as Capability[]),
        tunnelUrl: "http://localhost:5174",
        linkSecret: "secret-hash",
        createdAt: new Date().toISOString(),
      });
    }
  };

  return { app, linkRegistry, ctx, seedLink, threadUpdateSpy };
}

describe("POST /messages — VM-based dispatch", () => {
  const validBody = {
    messages: [
      {
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    ],
    agent: { id: AGENT_ID },
    branch: BRANCH,
    temperature: 0.5,
  };

  test("VM with user-desktop kind + no online link → 409 user_desktop_link_offline", async () => {
    const { app } = buildApp({ vmKind: "user-desktop", linkOnline: false });
    const res = await app.request(
      `/api/org_1/decopilot/threads/${THREAD_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe("link_unavailable");
    expect(body.code).toBe("user_desktop_link_offline");
  });

  test("VM with user-desktop kind + link missing capability → 409 user_desktop_link_capability_missing", async () => {
    const { app, seedLink } = buildApp({
      vmKind: "user-desktop",
      linkOnline: true,
      linkCapabilities: ["decopilot-sandbox"],
    });
    await seedLink();
    // Link exists but only advertises decopilot-sandbox — claude-code
    // provider expects "claude-code".
    const res = await app.request(
      `/api/org_1/decopilot/threads/${THREAD_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      code: string;
      activeCapabilities: string[];
    };
    expect(body.code).toBe("user_desktop_link_capability_missing");
    expect(body.activeCapabilities).toEqual(["decopilot-sandbox"]);
  });

  test("VM with cloud kind → 202 (target is local/default)", async () => {
    const { app } = buildApp({ vmKind: "local-docker", linkOnline: false });
    const res = await app.request(
      `/api/org_1/decopilot/threads/${THREAD_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      },
    );
    expect(res.status).toBe(202);
  });
});

// ============================================================================
// POST /messages — first-message pinning
// ============================================================================
//
// These tests exercise the logic added in Task 3.2:
//   - First message (thread row has null pins) → derive + persist pins.
//   - Subsequent message (thread row already has pins) → use them, no update.

describe("POST /messages — first-message pinning", () => {
  const validBody = {
    messages: [
      {
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    ],
    agent: { id: AGENT_ID },
    branch: BRANCH,
    temperature: 0.5,
  };

  test("first message with explicit pins persists them and uses them", async () => {
    const { app, seedLink, threadUpdateSpy } = buildApp({
      vmKind: "user-desktop",
      linkOnline: true,
      threadPins: { sandbox_provider_kind: null, harness_id: null },
    });
    await seedLink();
    const res = await app.request(
      `/api/org_1/decopilot/threads/${THREAD_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...validBody,
          sandboxProviderKind: "user-desktop",
          harnessId: "claude-code",
        }),
      },
    );
    expect(res.status).toBe(202);
    expect(threadUpdateSpy).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({
        sandbox_provider_kind: "user-desktop",
        harness_id: "claude-code",
      }),
    );
  });

  test("first message without explicit pins derives defaults and persists", async () => {
    const { app, seedLink, threadUpdateSpy } = buildApp({
      vmKind: "user-desktop",
      linkOnline: true,
      threadPins: { sandbox_provider_kind: null, harness_id: null },
    });
    await seedLink();
    const res = await app.request(
      `/api/org_1/decopilot/threads/${THREAD_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(validBody),
      },
    );
    expect(res.status).toBe(202);
    // link is online → resolveDefaultSandboxProviderKind returns vmKindForTest
    // which is "user-desktop"
    expect(threadUpdateSpy).toHaveBeenCalledWith(
      THREAD_ID,
      expect.objectContaining({
        sandbox_provider_kind: "user-desktop",
      }),
    );
  });

  test("subsequent message ignores request pins and uses thread row", async () => {
    // Thread is pinned to (user-desktop, claude-code). The request body sends
    // harnessId: "decopilot" which would require the decopilot-sandbox
    // capability. If the route mistakenly uses the body's harnessId, the link
    // check fails with 409 user_desktop_link_capability_missing. Using the pinned harness
    // (claude-code) instead → the link's claude-code capability matches → 202.
    const { app, seedLink, threadUpdateSpy } = buildApp({
      vmKind: "user-desktop",
      linkOnline: true,
      threadPins: {
        sandbox_provider_kind: "user-desktop",
        harness_id: "claude-code",
      },
    });
    await seedLink();
    const res = await app.request(
      `/api/org_1/decopilot/threads/${THREAD_ID}/messages`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...validBody,
          sandboxProviderKind: "local-docker", // should be ignored — thread row has user-desktop
          harnessId: "decopilot", // should be ignored — thread row has claude-code
        }),
      },
    );
    // 202 proves the pinned harness (claude-code) was used, not "decopilot"
    // which would have produced a 409 user_desktop_link_capability_missing.
    expect(res.status).toBe(202);
    // Pins were already set — no update should be written.
    expect(threadUpdateSpy).not.toHaveBeenCalled();
  });
});
