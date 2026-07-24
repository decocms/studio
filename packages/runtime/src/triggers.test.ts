import { describe, expect, it, spyOn } from "bun:test";
import { z } from "zod";
import { createTriggers, type TriggerStorage } from "./triggers.ts";

// biome-ignore lint: test mocks don't need full type compliance
const mockCtx = (connectionId?: string) =>
  ({
    env: connectionId
      ? { STUDIO_REQUEST_CONTEXT: { connectionId } }
      : { STUDIO_REQUEST_CONTEXT: {} },
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
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "test-token-123",
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
      "https://studio.example.com/api/trigger-callback",
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

  it("disabling one trigger keeps credentials when another is still active", async () => {
    const configureTool = triggers.tools()[1];

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    // Enable two trigger types
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "token-multi",
      },
      runtimeContext: mockCtx("conn-multi"),
    });
    await configureTool.execute({
      context: {
        type: "github.pull_request.opened",
        params: {},
        enabled: true,
      },
      runtimeContext: mockCtx("conn-multi"),
    });

    // Disable one — credentials should stay for the other
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: false,
      },
      runtimeContext: mockCtx("conn-multi"),
    });

    triggers.notify("conn-multi", "github.pull_request.opened", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("disabling the last trigger clears credentials", async () => {
    const configureTool = triggers.tools()[1];

    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );

    // Enable a trigger
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "token-cleanup",
      },
      runtimeContext: mockCtx("conn-cleanup"),
    });

    // Disable it — last trigger, credentials should be cleared
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: false,
      },
      runtimeContext: mockCtx("conn-cleanup"),
    });

    triggers.notify("conn-cleanup", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it("notify is a no-op when no credentials exist", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 202 }),
    );
    triggers.notify("unknown-conn", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("notify logs error on non-2xx response", async () => {
    const configureTool = triggers.tools()[1];
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Unauthorized", { status: 401, statusText: "Unauthorized" }),
    );
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});

    // Ensure credentials exist (reuse from prior test state or set up fresh)
    await configureTool.execute({
      context: {
        type: "github.push",
        params: {},
        enabled: true,
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "token-err",
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
});

describe("createTriggers with storage", () => {
  function createMockStorage(): TriggerStorage & {
    data: Map<string, unknown>;
  } {
    const data = new Map<string, unknown>();
    return {
      data,
      get: async (id) => (data.get(id) as any) ?? null,
      set: async (id, state) => {
        data.set(id, state);
      },
      delete: async (id) => {
        data.delete(id);
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
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "persisted-token",
      },
      runtimeContext: mockCtx("conn-persist"),
    });

    expect(storage.data.has("conn-persist")).toBe(true);
    const stored = storage.data.get("conn-persist") as any;
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
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "to-delete",
      },
      runtimeContext: mockCtx("conn-del"),
    });

    expect(storage.data.has("conn-del")).toBe(true);

    await configureTool.execute({
      context: { type: "github.push", params: {}, enabled: false },
      runtimeContext: mockCtx("conn-del"),
    });

    expect(storage.data.has("conn-del")).toBe(false);
  });

  it("restores credentials from storage on notify after restart", async () => {
    const storage = createMockStorage();

    // Simulate prior session: write state directly to storage
    storage.data.set("conn-restart", {
      credentials: {
        callbackUrl: "https://studio.example.com/api/trigger-callback",
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
      "https://studio.example.com/api/trigger-callback",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer restored-token",
        }),
      }),
    );

    fetchSpy.mockRestore();
  });

  it("enable after restart preserves other persisted trigger types", async () => {
    const storage = createMockStorage();

    // Simulate prior session: "github.push" was already active
    storage.data.set("conn-enable-restart", {
      credentials: {
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "prior-token",
      },
      activeTriggerTypes: ["github.push"],
    });

    // New instance (simulates restart) — in-memory cache is empty
    const t = createTriggers({
      definitions: [
        ...defs,
        {
          type: "github.pull_request.opened" as const,
          description: "PR opened",
          params: z.object({ repo: z.string().describe("Repo") }),
        },
      ],
      storage,
    });
    const configureTool = t.tools()[1];

    // Enable a second trigger type without redeclaring credentials
    await configureTool.execute({
      context: {
        type: "github.pull_request.opened",
        params: {},
        enabled: true,
      },
      runtimeContext: mockCtx("conn-enable-restart"),
    });

    const stored = storage.data.get("conn-enable-restart") as any;
    expect(stored.activeTriggerTypes.sort()).toEqual([
      "github.pull_request.opened",
      "github.push",
    ]);
  });

  it("disable after restart clears persisted credentials from storage", async () => {
    const storage = createMockStorage();

    // Simulate prior session
    storage.data.set("conn-disable-restart", {
      credentials: {
        callbackUrl: "https://studio.example.com/api/trigger-callback",
        callbackToken: "stale-token",
      },
      activeTriggerTypes: ["github.push"],
    });

    // New instance (simulates restart)
    const t = createTriggers({ definitions: defs, storage });
    const configureTool = t.tools()[1];

    // Disable the trigger — should load from storage, then clean up
    await configureTool.execute({
      context: { type: "github.push", params: {}, enabled: false },
      runtimeContext: mockCtx("conn-disable-restart"),
    });

    expect(storage.data.has("conn-disable-restart")).toBe(false);

    // notify should be a no-op
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    t.notify("conn-disable-restart", "github.push", {});
    await new Promise((r) => setTimeout(r, 50));
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("No callback credentials"),
    );
    consoleSpy.mockRestore();
  });
});
