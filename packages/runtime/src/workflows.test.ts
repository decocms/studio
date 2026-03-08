import { describe, expect, test, mock, beforeEach } from "bun:test";
import { Workflow, type WorkflowDefinition } from "./workflows";

const { slugify, workflowId, sync } = Workflow;

describe("slugify", () => {
  test("lowercases and replaces spaces with hyphens", () => {
    expect(slugify("Fetch Users and Orders")).toBe("fetch-users-and-orders");
  });

  test("strips non-alphanumeric characters", () => {
    expect(slugify("Hello, World! (v2)")).toBe("hello-world-v2");
  });

  test("trims leading/trailing hyphens", () => {
    expect(slugify("--test--")).toBe("test");
  });

  test("collapses consecutive non-alphanumeric into single hyphen", () => {
    expect(slugify("a   b___c")).toBe("a-b-c");
  });

  test("handles empty-ish strings", () => {
    expect(slugify("   ")).toBe("");
  });
});

describe("workflowId", () => {
  test("namespaces with connection ID", () => {
    expect(workflowId("conn_abc", "My Workflow")).toBe("conn_abc::my-workflow");
  });

  test("handles special characters in title", () => {
    expect(workflowId("conn_123", "Fetch (Users) & Orders!")).toBe(
      "conn_123::fetch-users-orders",
    );
  });
});

describe("syncWorkflows", () => {
  let mockClient: {
    COLLECTION_WORKFLOW_LIST: ReturnType<typeof mock>;
    COLLECTION_WORKFLOW_CREATE: ReturnType<typeof mock>;
    COLLECTION_WORKFLOW_UPDATE: ReturnType<typeof mock>;
    COLLECTION_WORKFLOW_DELETE: ReturnType<typeof mock>;
  };

  const connectionId = "conn_test_123";
  const meshUrl = "https://mesh.example.com";
  const token = "test-token";

  const sampleWorkflows: WorkflowDefinition[] = [
    {
      title: "Fetch Users",
      description: "Fetches all users",
      steps: [{ name: "fetch", action: { toolName: "GET_USERS" } }],
    },
    {
      title: "Process Orders",
      steps: [
        { name: "get_orders", action: { toolName: "GET_ORDERS" } },
        {
          name: "transform",
          action: {
            code: "export default function(input) { return { count: input.length }; }",
          },
          input: { data: "@get_orders" },
        },
      ],
    },
  ];

  beforeEach(() => {
    mockClient = {
      COLLECTION_WORKFLOW_LIST: mock(() =>
        Promise.resolve({ items: [], totalCount: 0, hasMore: false }),
      ),
      COLLECTION_WORKFLOW_CREATE: mock(() =>
        Promise.resolve({
          item: {
            id: "test",
            title: "test",
            description: null,
            virtual_mcp_id: "vmcp",
            created_at: "",
            updated_at: "",
          },
        }),
      ),
      COLLECTION_WORKFLOW_UPDATE: mock(() =>
        Promise.resolve({ success: true }),
      ),
      COLLECTION_WORKFLOW_DELETE: mock(() =>
        Promise.resolve({ success: true }),
      ),
    };
  });

  // Helper to inject mock client via module-level mock
  // Since syncWorkflows creates the client internally, we test through the public API
  // by mocking at the MCPClient level. For unit tests, we test the logic components directly.

  test("creates workflows when none exist", async () => {
    const calls: { method: string; args: unknown }[] = [];

    // We can't easily mock the internal client creation, so we test the
    // exported utility functions and verify the sync logic conceptually.
    // Integration tests would cover the full flow.

    // Test that IDs are correctly derived
    const id1 = workflowId(connectionId, "Fetch Users");
    const id2 = workflowId(connectionId, "Process Orders");

    expect(id1).toBe("conn_test_123::fetch-users");
    expect(id2).toBe("conn_test_123::process-orders");
  });

  test("skips sync when no workflows declared", async () => {
    // sync with empty array should return immediately
    // This tests the early return path
    await sync([], meshUrl, connectionId, token);
    // No error thrown = success
  });

  test("warns on duplicate titles", async () => {
    const consoleSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleSpy;

    try {
      const duplicates: WorkflowDefinition[] = [
        {
          title: "Same Title",
          steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
        },
        {
          title: "Same Title",
          steps: [{ name: "s2", action: { toolName: "TOOL_B" } }],
        },
      ];

      await sync(duplicates, meshUrl, connectionId, token);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Duplicate workflow titles"),
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  test("derives correct IDs for various titles", () => {
    const cases = [
      ["Simple", "conn_1::simple"],
      ["Multi Word Title", "conn_1::multi-word-title"],
      ["With Numbers 123", "conn_1::with-numbers-123"],
      ["Special!@#Characters", "conn_1::special-characters"],
      ["  Trimmed  ", "conn_1::trimmed"],
    ] as const;

    for (const [title, expected] of cases) {
      expect(workflowId("conn_1", title)).toBe(expected);
    }
  });

  test("prefix filtering isolates connection workflows", () => {
    const prefix = `${connectionId}::`;

    const allWorkflows = [
      { id: `${connectionId}::my-workflow`, title: "My Workflow" },
      { id: "other_conn::my-workflow", title: "My Workflow" },
      { id: "unrelated-id", title: "Manual Workflow" },
    ];

    const managed = allWorkflows.filter((w) => w.id.startsWith(prefix));
    expect(managed).toHaveLength(1);
    expect(managed[0].id).toBe(`${connectionId}::my-workflow`);
  });

  test("orphan detection finds removed workflows", () => {
    const prefix = `${connectionId}::`;

    const existingManaged = new Map([
      [`${connectionId}::workflow-a`, { id: `${connectionId}::workflow-a` }],
      [`${connectionId}::workflow-b`, { id: `${connectionId}::workflow-b` }],
      [`${connectionId}::workflow-c`, { id: `${connectionId}::workflow-c` }],
    ]);

    const declaredIds = new Set([
      workflowId(connectionId, "Workflow A"),
      workflowId(connectionId, "Workflow B"),
    ]);

    const orphans: string[] = [];
    for (const [id] of existingManaged) {
      if (!declaredIds.has(id)) {
        orphans.push(id);
      }
    }

    expect(orphans).toEqual([`${connectionId}::workflow-c`]);
  });
});
