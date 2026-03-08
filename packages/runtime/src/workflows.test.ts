import { describe, expect, mock, test } from "bun:test";
import { Workflow, createWorkflow, type WorkflowDefinition } from "./workflows";

// ---------------------------------------------------------------------------
// Minimal fake client factory used in payload-contract tests.
// ---------------------------------------------------------------------------
type Call = { method: string; args: unknown };

function makeFakeClient(
  existing: {
    id: string;
    title: string;
    virtual_mcp_id?: string | null;
  }[] = [],
  opts: { listFails?: boolean; createFails?: Set<string> } = {},
) {
  const calls: Call[] = [];

  const client = {
    COLLECTION_WORKFLOW_LIST: mock(async () => {
      if (opts.listFails) throw new Error("plugin not enabled");
      return {
        items: existing.map((w) => ({
          id: w.id,
          title: w.title,
          description: null,
          virtual_mcp_id: w.virtual_mcp_id ?? null,
          created_at: "",
          updated_at: "",
        })),
        totalCount: existing.length,
        hasMore: false,
      };
    }),
    COLLECTION_WORKFLOW_CREATE: mock(async (args: unknown) => {
      const id = (args as { data: { id: string } }).data.id;
      if (opts.createFails?.has(id)) throw new Error(`create failed for ${id}`);
      calls.push({ method: "CREATE", args });
      return {
        item: {
          id,
          title: "",
          description: null,
          virtual_mcp_id: null,
          created_at: "",
          updated_at: "",
        },
      };
    }),
    COLLECTION_WORKFLOW_UPDATE: mock(async (args: unknown) => {
      calls.push({ method: "UPDATE", args });
      return { success: true };
    }),
    COLLECTION_WORKFLOW_DELETE: mock(async (args: unknown) => {
      calls.push({ method: "DELETE", args });
      return { success: true };
    }),
  };

  return { client, calls };
}

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

// ---------------------------------------------------------------------------
// Real syncWorkflows integration tests using fake client
// ---------------------------------------------------------------------------
describe("syncWorkflows", () => {
  const connectionId = "conn_test_123";
  const meshUrl = "https://mesh.example.com";

  test("creates workflow when it does not exist yet", async () => {
    const { client, calls } = makeFakeClient();

    const workflows: WorkflowDefinition[] = [
      {
        title: "New Workflow",
        steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
      },
    ];

    await sync(workflows, meshUrl, connectionId, undefined, client as never);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("CREATE");
    expect((calls[0].args as { data: { id: string } }).data.id).toBe(
      workflowId(connectionId, "New Workflow"),
    );
    expect(client.COLLECTION_WORKFLOW_DELETE).not.toHaveBeenCalled();
  });

  test("updates workflow when it already exists", async () => {
    const id = workflowId(connectionId, "Existing");
    const { client, calls } = makeFakeClient([{ id, title: "Existing" }]);

    const workflows: WorkflowDefinition[] = [
      {
        title: "Existing",
        description: "updated desc",
        steps: [{ name: "s1", action: { toolName: "TOOL_B" } }],
      },
    ];

    await sync(workflows, meshUrl, connectionId, undefined, client as never);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("UPDATE");
    expect((calls[0].args as { id: string }).id).toBe(id);
    expect(client.COLLECTION_WORKFLOW_CREATE).not.toHaveBeenCalled();
  });

  test("deletes orphaned workflows that are no longer declared", async () => {
    const idA = workflowId(connectionId, "Workflow A");
    const idOrphan = workflowId(connectionId, "Orphan");
    const { client, calls } = makeFakeClient([
      { id: idA, title: "Workflow A" },
      { id: idOrphan, title: "Orphan" },
    ]);

    const workflows: WorkflowDefinition[] = [
      {
        title: "Workflow A",
        steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
      },
    ];

    await sync(workflows, meshUrl, connectionId, undefined, client as never);

    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect((deleteCalls[0].args as { id: string }).id).toBe(idOrphan);
  });

  test("cleans up all managed workflows when declared is empty", async () => {
    const id1 = workflowId(connectionId, "Old Workflow 1");
    const id2 = workflowId(connectionId, "Old Workflow 2");
    const { client, calls } = makeFakeClient([
      { id: id1, title: "Old Workflow 1" },
      { id: id2, title: "Old Workflow 2" },
    ]);

    await sync([], meshUrl, connectionId, undefined, client as never);

    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(2);
    const deletedIds = deleteCalls.map((c) => (c.args as { id: string }).id);
    expect(deletedIds).toContain(id1);
    expect(deletedIds).toContain(id2);
    expect(client.COLLECTION_WORKFLOW_CREATE).not.toHaveBeenCalled();
  });

  test("does not touch workflows owned by a different connection", async () => {
    const otherId = "other_conn::some-workflow";
    const { client, calls } = makeFakeClient([
      { id: otherId, title: "Some Workflow" },
    ]);

    await sync([], meshUrl, connectionId, undefined, client as never);

    const deleteCalls = calls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
  });

  test("continues syncing remaining workflows when one CREATE fails", async () => {
    const failingId = workflowId(connectionId, "Bad Workflow");
    const goodId = workflowId(connectionId, "Good Workflow");

    const { client, calls } = makeFakeClient([], {
      createFails: new Set([failingId]),
    });

    const consoleSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleSpy;

    try {
      const workflows: WorkflowDefinition[] = [
        {
          title: "Bad Workflow",
          steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
        },
        {
          title: "Good Workflow",
          steps: [{ name: "s1", action: { toolName: "TOOL_B" } }],
        },
      ];

      await sync(workflows, meshUrl, connectionId, undefined, client as never);
    } finally {
      console.warn = originalWarn;
    }

    const createCalls = calls.filter((c) => c.method === "CREATE");
    expect(createCalls).toHaveLength(1);
    expect((createCalls[0].args as { data: { id: string } }).data.id).toBe(
      goodId,
    );
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Bad Workflow"),
      expect.anything(),
    );
  });

  test("skips sync entirely when list call fails", async () => {
    const { client, calls } = makeFakeClient([], { listFails: true });

    const consoleSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleSpy;

    try {
      await sync(
        [
          {
            title: "My Workflow",
            steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
          },
        ],
        meshUrl,
        connectionId,
        undefined,
        client as never,
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(calls).toHaveLength(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("workflows plugin may not be enabled"),
    );
  });

  test("warns on duplicate titles and aborts", async () => {
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

      const { client } = makeFakeClient();
      await sync(duplicates, meshUrl, connectionId, undefined, client as never);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Workflow titles that produce duplicate IDs"),
      );
      expect(client.COLLECTION_WORKFLOW_CREATE).not.toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("warns when distinct titles produce the same slug", async () => {
    const consoleSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleSpy;

    try {
      const colliding: WorkflowDefinition[] = [
        {
          title: "Hello World",
          steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
        },
        {
          title: "Hello  World",
          steps: [{ name: "s2", action: { toolName: "TOOL_B" } }],
        },
      ];

      const { client } = makeFakeClient();
      await sync(colliding, meshUrl, connectionId, undefined, client as never);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Workflow titles that produce duplicate IDs"),
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
});

// ---------------------------------------------------------------------------
// Payload contract tests — verify virtual_mcp_id is correctly forwarded.
// ---------------------------------------------------------------------------
describe("syncWorkflows payload contracts", () => {
  const connectionId = "conn_test_123";
  const meshUrl = "https://mesh.example.com";

  test("CREATE payload includes virtual_mcp_id when declared", async () => {
    const { client, calls } = makeFakeClient();

    const workflows: WorkflowDefinition[] = [
      {
        title: "My Workflow",
        virtual_mcp_id: "vmcp_custom",
        steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
      },
    ];

    await sync(workflows, meshUrl, connectionId, undefined, client as never);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("CREATE");
    expect(
      (call.args as { data: { virtual_mcp_id?: string } }).data.virtual_mcp_id,
    ).toBe("vmcp_custom");
  });

  test("CREATE payload forwards undefined virtual_mcp_id (server applies its default)", async () => {
    const { client, calls } = makeFakeClient();

    const workflows: WorkflowDefinition[] = [
      {
        title: "No Vmcp",
        steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
      },
    ];

    await sync(workflows, meshUrl, connectionId, undefined, client as never);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("CREATE");
    // Field is present as undefined (not omitted entirely), letting server default take effect.
    expect(
      Object.prototype.hasOwnProperty.call(
        (call.args as { data: unknown }).data,
        "virtual_mcp_id",
      ),
    ).toBe(true);
  });

  test("UPDATE payload includes virtual_mcp_id when declared", async () => {
    const { client, calls } = makeFakeClient([
      { id: `${connectionId}::existing`, title: "Existing" },
    ]);

    const workflows: WorkflowDefinition[] = [
      {
        title: "Existing",
        virtual_mcp_id: "vmcp_updated",
        steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
      },
    ];

    await sync(workflows, meshUrl, connectionId, undefined, client as never);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("UPDATE");
    expect(
      (call.args as { data: { virtual_mcp_id?: string } }).data.virtual_mcp_id,
    ).toBe("vmcp_updated");
  });

  test("UPDATE payload omits virtual_mcp_id when not declared (preserves server value)", async () => {
    const { client, calls } = makeFakeClient([
      { id: `${connectionId}::existing`, title: "Existing" },
    ]);

    const workflows: WorkflowDefinition[] = [
      {
        title: "Existing",
        steps: [{ name: "s1", action: { toolName: "TOOL_A" } }],
      },
    ];

    await sync(workflows, meshUrl, connectionId, undefined, client as never);

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe("UPDATE");
    // Omitting virtual_mcp_id on update preserves the existing server value (no accidental reset).
    expect(
      Object.prototype.hasOwnProperty.call(
        (call.args as { data: unknown }).data,
        "virtual_mcp_id",
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// I6: Empty / whitespace title guard
// ---------------------------------------------------------------------------
describe("syncWorkflows — empty title guard (I6)", () => {
  const meshUrl = "https://mesh.example.com";

  test("warns and skips sync when a workflow has a whitespace-only title", async () => {
    const consoleSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleSpy;

    try {
      const { client } = makeFakeClient();
      await sync(
        [{ title: "   ", steps: [{ name: "s1", action: { toolName: "T" } }] }],
        meshUrl,
        "conn_i6_whitespace",
        undefined,
        client as never,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("empty ID"),
      );
      expect(client.COLLECTION_WORKFLOW_LIST).not.toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("warns and skips sync when a workflow has an empty string title", async () => {
    const consoleSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleSpy;

    try {
      const { client } = makeFakeClient();
      await sync(
        [{ title: "", steps: [{ name: "s1", action: { toolName: "T" } }] }],
        meshUrl,
        "conn_i6_empty",
        undefined,
        client as never,
      );

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("empty ID"),
      );
      expect(client.COLLECTION_WORKFLOW_LIST).not.toHaveBeenCalled();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("one empty-title workflow in a mixed list blocks the entire sync", async () => {
    const { client } = makeFakeClient();
    const consoleSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = consoleSpy;

    try {
      await sync(
        [
          {
            title: "Good Workflow",
            steps: [{ name: "s1", action: { toolName: "A" } }],
          },
          { title: "  ", steps: [{ name: "s2", action: { toolName: "B" } }] },
        ],
        meshUrl,
        "conn_i6_mixed",
        undefined,
        client as never,
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(client.COLLECTION_WORKFLOW_CREATE).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// I4: Fingerprint-based skip + I7: Concurrency serialization
// ---------------------------------------------------------------------------
describe("syncWorkflows — fingerprint skip (I4) and concurrency guard (I7)", () => {
  const meshUrl = "https://mesh.example.com";
  const wf = [
    {
      title: "My Workflow",
      steps: [{ name: "s1", action: { toolName: "T" } }],
    },
  ];

  test("skips LIST on second sync when declared content is identical (I4)", async () => {
    const { client } = makeFakeClient();
    const connectionId = "conn_i4_skip";

    await sync(wf, meshUrl, connectionId, undefined, client as never);
    expect(client.COLLECTION_WORKFLOW_LIST).toHaveBeenCalledTimes(1);

    await sync(wf, meshUrl, connectionId, undefined, client as never);
    // Still 1 — fingerprint matched, remote round-trip skipped.
    expect(client.COLLECTION_WORKFLOW_LIST).toHaveBeenCalledTimes(1);
  });

  test("re-syncs when declared content changes (I4)", async () => {
    const { client } = makeFakeClient();
    const connectionId = "conn_i4_rerun";

    await sync(wf, meshUrl, connectionId, undefined, client as never);
    expect(client.COLLECTION_WORKFLOW_LIST).toHaveBeenCalledTimes(1);

    const updated = [
      { title: "My Workflow", description: "new desc", steps: wf[0].steps },
    ];
    await sync(updated, meshUrl, connectionId, undefined, client as never);
    expect(client.COLLECTION_WORKFLOW_LIST).toHaveBeenCalledTimes(2);
  });

  test("two concurrent syncs for the same connectionId do not error and issue exactly one LIST (I7 + I4)", async () => {
    const { client } = makeFakeClient();
    const connectionId = "conn_i7_concurrent";

    await Promise.all([
      sync(wf, meshUrl, connectionId, undefined, client as never),
      sync(wf, meshUrl, connectionId, undefined, client as never),
    ]);

    // First call syncs and sets the fingerprint; second is serialized and
    // finds the fingerprint already set — skips the LIST entirely.
    expect(client.COLLECTION_WORKFLOW_LIST).toHaveBeenCalledTimes(1);
  });

  test("different connectionIds are fingerprinted independently (I4)", async () => {
    const { client: c1 } = makeFakeClient();
    const { client: c2 } = makeFakeClient();

    await sync(wf, meshUrl, "conn_i4_independent_a", undefined, c1 as never);
    await sync(wf, meshUrl, "conn_i4_independent_b", undefined, c2 as never);

    // Same content, different connections — each must hit the server once.
    expect(c1.COLLECTION_WORKFLOW_LIST).toHaveBeenCalledTimes(1);
    expect(c2.COLLECTION_WORKFLOW_LIST).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// WorkflowBuilder unit tests
// ---------------------------------------------------------------------------
describe("WorkflowBuilder (createWorkflow)", () => {
  test("step() appends a step to the build output", () => {
    const wf = createWorkflow({ title: "Test" })
      .step("fetch", { action: { toolName: "FETCH_TOOL" } })
      .build();

    expect(wf.steps).toHaveLength(1);
    expect(wf.steps[0].name).toBe("fetch");
    expect((wf.steps[0].action as { toolName: string }).toolName).toBe(
      "FETCH_TOOL",
    );
  });

  test("forEachItem() defaults concurrency to 1", () => {
    const wf = createWorkflow({ title: "Test" })
      .step("list", { action: { toolName: "LIST_TOOL" } })
      .forEachItem("process", "@list", { action: { toolName: "PROC_TOOL" } })
      .build();

    expect(wf.steps).toHaveLength(2);
    const forEach = wf.steps[1].forEach;
    expect(forEach).toBeDefined();
    expect(forEach?.concurrency).toBe(1);
    expect(forEach?.ref).toBe("@list");
  });

  test("forEachItem() respects explicit concurrency", () => {
    const wf = createWorkflow({ title: "Test" })
      .step("list", { action: { toolName: "LIST_TOOL" } })
      .forEachItem("process", "@list", {
        action: { toolName: "PROC_TOOL" },
        concurrency: 5,
      })
      .build();

    expect(wf.steps[1].forEach?.concurrency).toBe(5);
  });

  test("addSteps() splices in pre-built steps", () => {
    const extra = [
      { name: "extra1", action: { toolName: "X" } },
      { name: "extra2", action: { toolName: "Y" } },
    ];

    const wf = createWorkflow({ title: "Test" })
      .step("first", { action: { toolName: "A" } })
      .addSteps(extra)
      .build();

    expect(wf.steps).toHaveLength(3);
    expect(wf.steps[1].name).toBe("extra1");
    expect(wf.steps[2].name).toBe("extra2");
  });

  test("build() returns a fresh copy — mutations do not bleed back", () => {
    const builder = createWorkflow({ title: "Test" }).step("s1", {
      action: { toolName: "A" },
    });

    const first = builder.build();
    builder.step("s2", { action: { toolName: "B" } });
    const second = builder.build();

    expect(first.steps).toHaveLength(1);
    expect(second.steps).toHaveLength(2);
  });

  test("build() preserves meta fields (title, description, virtual_mcp_id, toolId)", () => {
    const wf = createWorkflow({
      title: "My Flow",
      description: "desc",
      virtual_mcp_id: "vmcp_123",
      toolId: "CUSTOM_TRIGGER",
    }).build();

    expect(wf.title).toBe("My Flow");
    expect(wf.description).toBe("desc");
    expect(wf.virtual_mcp_id).toBe("vmcp_123");
    expect(wf.toolId).toBe("CUSTOM_TRIGGER");
    expect(wf.steps).toHaveLength(0);
  });

  test("multiple .step() calls accumulate in order", () => {
    const wf = createWorkflow({ title: "Pipeline" })
      .step("a", { action: { toolName: "A" } })
      .step("b", { action: { toolName: "B" } })
      .step("c", { action: { toolName: "C" } })
      .build();

    expect(wf.steps.map((s) => s.name)).toEqual(["a", "b", "c"]);
  });
});
