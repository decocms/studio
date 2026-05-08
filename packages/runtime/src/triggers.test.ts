import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import { createTriggers, type TriggerStorage } from "./triggers.ts";

// biome-ignore lint: test mocks don't need full type compliance
const mockCtx = (connectionId?: string) =>
  ({
    env: connectionId
      ? { MESH_REQUEST_CONTEXT: { connectionId } }
      : { MESH_REQUEST_CONTEXT: {} },
    ctx: { waitUntil: () => {} },
  }) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

const triggers = createTriggers([
  {
    type: "github.push",
    description: "Triggered when code is pushed",
    params: z.object({
      repo: z.string().describe("Repository full name (owner/repo)"),
    }),
  },
  {
    type: "github.pull_request.opened",
    description: "Triggered when a PR is opened",
    params: z.object({
      repo: z.string().describe("Repository full name"),
    }),
  },
]);

describe("createTriggers", () => {
  it("tools() returns TRIGGER_LIST and TRIGGER_CONFIGURE", () => {
    const tools = triggers.tools();
    expect(tools).toHaveLength(2);
    expect(tools[0].id).toBe("TRIGGER_LIST");
    expect(tools[1].id).toBe("TRIGGER_CONFIGURE");
  });

  it("TRIGGER_LIST returns trigger definitions with paramsSchema", async () => {
    const listTool = triggers.tools()[0];
    const result = (await listTool.execute({
      context: {},
      runtimeContext: mockCtx(),
    })) as {
      triggers: Array<{ type: string; paramsSchema: Record<string, unknown> }>;
    };

    expect(result.triggers).toHaveLength(2);
    expect(result.triggers[0].type).toBe("github.push");
    expect(result.triggers[0].paramsSchema).toEqual({
      repo: {
        type: "string",
        description: "Repository full name (owner/repo)",
      },
    });
    expect(result.triggers[1].type).toBe("github.pull_request.opened");
  });

  it("TRIGGER_LIST includes enum values from z.enum params", async () => {
    const enumTriggers = createTriggers([
      {
        type: "test.event",
        description: "Test",
        params: z.object({
          action: z.enum(["opened", "closed", "merged"]).describe("PR action"),
        }),
      },
    ]);
    const listTool = enumTriggers.tools()[0];
    const result = (await listTool.execute({
      context: {},
      runtimeContext: mockCtx(),
    })) as {
      triggers: Array<{ paramsSchema: Record<string, { enum?: string[] }> }>;
    };
    expect(result.triggers[0].paramsSchema.action.enum).toEqual([
      "opened",
      "closed",
      "merged",
    ]);
  });

  it("TRIGGER_CONFIGURE stores callback credentials and notify delivers", async () => {
    const configureTool = triggers.tools()[1];

    const mockResponse = new Response("ok", { status: 202 });
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(mockResponse);

    // Configure a trigger with callback
    await configureTool.execute({
      context: {
        type: "github.push",
        params: { repo: "owner/repo" },
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "test-token-123",
        subscriptionId: "sub-1",
      },
      runtimeContext: mockCtx("conn-1"),
    });

    // Notify should POST to the callback URL
    triggers.notify("conn-1", "github.push", {
      repository: { full_name: "owner/repo" },
    });

    // Wait for the fire-and-forget fetch
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://mesh.example.com/api/trigger-callback",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token-123",
        },
      }),
    );

    const callBody = JSON.parse(
      (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(callBody.type).toBe("github.push");
    expect(callBody.data.repository.full_name).toBe("owner/repo");

    fetchSpy.mockRestore();
  });

  it("multiple subscriptions on same connection each get their own callback", async () => {
    const configureTool = triggers.tools()[1];
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    // Two distinct subscriptions on the same connection, same type, with
    // different callback tokens — both should fire on notify.
    await configureTool.execute({
      context: {
        type: "github.push",
        params: { repo: "alice/repo" },
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "token-A",
        subscriptionId: "sub-A",
      },
      runtimeContext: mockCtx("conn-multi-sub"),
    });
    await configureTool.execute({
      context: {
        type: "github.push",
        params: { repo: "bob/repo" },
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "token-B",
        subscriptionId: "sub-B",
      },
      runtimeContext: mockCtx("conn-multi-sub"),
    });

    triggers.notify("conn-multi-sub", "github.push", {
      repository: { full_name: "x/y" },
    });
    await new Promise((r) => setTimeout(r, 50));

    const tokens = fetchSpy.mock.calls.map((call) => {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      return headers.Authorization;
    });
    expect(tokens).toContain("Bearer token-A");
    expect(tokens).toContain("Bearer token-B");
    expect(fetchSpy.mock.calls).toHaveLength(2);

    fetchSpy.mockRestore();
  });

  it("disabling one subscription leaves siblings alive", async () => {
    const configureTool = triggers.tools()[1];

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "token-keep",
        subscriptionId: "keep",
      },
      runtimeContext: mockCtx("conn-sibling"),
    });
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "token-drop",
        subscriptionId: "drop",
      },
      runtimeContext: mockCtx("conn-sibling"),
    });

    // Disable the "drop" subscription only
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: false,
        subscriptionId: "drop",
      },
      runtimeContext: mockCtx("conn-sibling"),
    });

    fetchSpy.mockClear();
    triggers.notify("conn-sibling", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));

    const tokens = fetchSpy.mock.calls.map((call) => {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      return headers.Authorization;
    });
    expect(tokens).toEqual(["Bearer token-keep"]);

    fetchSpy.mockRestore();
  });

  it("disabling the last subscription clears credentials", async () => {
    const configureTool = triggers.tools()[1];

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "token-cleanup",
        subscriptionId: "only",
      },
      runtimeContext: mockCtx("conn-cleanup"),
    });

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: false,
        subscriptionId: "only",
      },
      runtimeContext: mockCtx("conn-cleanup"),
    });

    triggers.notify("conn-cleanup", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("No subscriptions"),
    );

    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it("notify is a no-op when no subscriptions exist", async () => {
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    triggers.notify("unknown-conn", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("No subscriptions"),
    );
    consoleSpy.mockRestore();
  });

  it("notify logs error on non-2xx response", async () => {
    const configureTool = triggers.tools()[1];
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "token-err",
        subscriptionId: "err",
      },
      runtimeContext: mockCtx("conn-err"),
    });

    fetchSpy.mockResolvedValue(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );

    triggers.notify("conn-err", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Callback delivery failed"),
    );

    fetchSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("TRIGGER_CONFIGURE throws without connectionId", async () => {
    const configureTool = triggers.tools()[1];
    expect(
      configureTool.execute({
        context: { type: "github.push", params: {}, enabled: true },
        runtimeContext: mockCtx(),
      }),
    ).rejects.toThrow("Connection ID not available");
  });

  it("TRIGGER_CONFIGURE without subscriptionId uses legacy default slot", async () => {
    // Backward-compat path: studio versions that don't pass subscriptionId
    // collapse to a single sub per connection. Two enables overwrite each
    // other (same as the pre-multi-sub behavior).
    const t = createTriggers([
      {
        type: "github.push" as const,
        description: "Push",
        params: z.object({ repo: z.string() }),
      },
    ]);
    const configureTool = t.tools()[1];
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "first",
      },
      runtimeContext: mockCtx("conn-legacy"),
    });
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "second",
      },
      runtimeContext: mockCtx("conn-legacy"),
    });

    t.notify("conn-legacy", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer second");

    fetchSpy.mockRestore();
  });
});

describe("createTriggers with storage", () => {
  function createMockStorage(): TriggerStorage & {
    data: Map<string, unknown>;
  } {
    const data = new Map<string, unknown>();
    const composite = (connId: string, subId: string) => `${connId}\x1f${subId}`;
    return {
      data,
      get: async (connId, subId) =>
        // biome-ignore lint: test mock
        ((data.get(composite(connId, subId)) as any) ?? null),
      set: async (connId, subId, state) => {
        data.set(composite(connId, subId), state);
      },
      delete: async (connId, subId) => {
        data.delete(composite(connId, subId));
      },
      list: async (connId) => {
        const prefix = `${connId}\x1f`;
        const out: Array<{ subscriptionId: string; state: any }> = [];
        for (const [key, state] of data.entries()) {
          if (key.startsWith(prefix)) {
            out.push({ subscriptionId: key.slice(prefix.length), state });
          }
        }
        return out;
      },
    };
  }

  const defs = [
    {
      type: "github.push" as const,
      description: "Push",
      params: z.object({
        repo: z.string().describe("Repo"),
      }),
    },
  ];

  it("persists trigger state to storage on configure", async () => {
    const storage = createMockStorage();
    const t = createTriggers({ definitions: defs, storage });
    const configureTool = t.tools()[1];

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "persisted-token",
        subscriptionId: "sub1",
      },
      runtimeContext: mockCtx("conn-persist"),
    });

    expect(storage.data.has("conn-persist\x1fsub1")).toBe(true);
    // biome-ignore lint: test mock
    const stored = storage.data.get("conn-persist\x1fsub1") as any;
    expect(stored.credentials.callbackToken).toBe("persisted-token");
    expect(stored.activeTriggerTypes).toEqual(["github.push"]);
  });

  it("deletes from storage when last trigger is disabled", async () => {
    const storage = createMockStorage();
    const t = createTriggers({ definitions: defs, storage });
    const configureTool = t.tools()[1];

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "to-delete",
        subscriptionId: "sub1",
      },
      runtimeContext: mockCtx("conn-del"),
    });

    expect(storage.data.has("conn-del\x1fsub1")).toBe(true);

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: false,
        subscriptionId: "sub1",
      },
      runtimeContext: mockCtx("conn-del"),
    });

    expect(storage.data.has("conn-del\x1fsub1")).toBe(false);
  });

  it("restores credentials from storage on notify after restart", async () => {
    const storage = createMockStorage();

    // Simulate prior session: write state directly to storage
    storage.data.set("conn-restart\x1fsub1", {
      credentials: {
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "restored-token",
      },
      activeTriggerTypes: ["github.push"],
    });

    // New instance (simulates restart) — in-memory cache is empty
    const t = createTriggers({ definitions: defs, storage });

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    t.notify("conn-restart", "github.push", { test: true });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://mesh.example.com/api/trigger-callback",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer restored-token",
        }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it("disable after restart clears the persisted subscription only", async () => {
    const storage = createMockStorage();

    // Simulate prior session with two siblings
    storage.data.set("conn-disable-restart\x1fkeep", {
      credentials: {
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "keep-token",
      },
      activeTriggerTypes: ["github.push"],
    });
    storage.data.set("conn-disable-restart\x1fdrop", {
      credentials: {
        callbackUrl: "https://mesh.example.com/api/trigger-callback",
        callbackToken: "drop-token",
      },
      activeTriggerTypes: ["github.push"],
    });

    const t = createTriggers({ definitions: defs, storage });
    const configureTool = t.tools()[1];

    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: false,
        subscriptionId: "drop",
      },
      runtimeContext: mockCtx("conn-disable-restart"),
    });

    expect(storage.data.has("conn-disable-restart\x1fdrop")).toBe(false);
    expect(storage.data.has("conn-disable-restart\x1fkeep")).toBe(true);

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );
    t.notify("conn-disable-restart", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });
});
