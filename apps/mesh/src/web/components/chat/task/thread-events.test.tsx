import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { KEYS } from "../../../lib/query-keys";
import {
  applyPatch,
  getThreadScopeFromKey,
  patchThreadCaches,
  prependRowToThreadCaches,
  scopeAcceptsRow,
} from "./thread-events";
import type { Task, TasksQueryData } from "./types";

function pagedData(items: Task[]): TasksQueryData {
  return {
    pages: [{ items, hasMore: false }],
    pageParams: [0],
  };
}

function flatItems(data: TasksQueryData | undefined): Task[] {
  return data?.pages.flatMap((p) => p.items) ?? [];
}

const emptyData: TasksQueryData = pagedData([]);

describe("applyPatch", () => {
  test("synthetic row carries created_by and trigger_id when provided", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "in_progress",
      updated_at: "2026-05-15T00:00:00Z",
    });
    expect(flatItems(out)[0]).toMatchObject({
      id: "t1",
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "in_progress",
    });
  });

  test("synthetic row preserves null trigger_id (human-initiated)", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      created_by: "user-1",
      trigger_id: null,
    });
    expect(flatItems(out)[0]?.trigger_id).toBeNull();
  });

  test("patching an existing row does not clobber created_by / trigger_id when undefined", () => {
    const existing = pagedData([
      {
        id: "t1",
        title: "Existing",
        created_at: "2026-05-15T00:00:00Z",
        updated_at: "2026-05-15T00:00:00Z",
        created_by: "user-1",
        trigger_id: "trig-1",
      },
    ]);
    const out = applyPatch(existing, { id: "t1", status: "completed" });
    expect(flatItems(out)[0]).toMatchObject({
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "completed",
    });
  });

  test("patching can update trigger_id when explicitly carried", () => {
    const existing = pagedData([
      {
        id: "t1",
        title: "Existing",
        created_at: "2026-05-15T00:00:00Z",
        updated_at: "2026-05-15T00:00:00Z",
        trigger_id: null,
      },
    ]);
    const out = applyPatch(existing, { id: "t1", trigger_id: "trig-1" });
    expect(flatItems(out)[0]?.trigger_id).toBe("trig-1");
  });

  test("synthetic row carries virtual_mcp_id when provided (so the agent icon renders on SSE-inserted rows)", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      virtual_mcp_id: "vmcp-1",
      status: "in_progress",
      updated_at: "2026-05-15T00:00:00Z",
    });
    expect(flatItems(out)[0]?.virtual_mcp_id).toBe("vmcp-1");
  });

  test("patching an existing row does not clobber virtual_mcp_id when undefined", () => {
    const existing = pagedData([
      {
        id: "t1",
        title: "Existing",
        created_at: "2026-05-15T00:00:00Z",
        updated_at: "2026-05-15T00:00:00Z",
        virtual_mcp_id: "vmcp-1",
      },
    ]);
    const out = applyPatch(existing, { id: "t1", status: "completed" });
    expect(flatItems(out)[0]?.virtual_mcp_id).toBe("vmcp-1");
  });

  test("canInsert:false skips synthetic insert for missing row", () => {
    const out = applyPatch(
      emptyData,
      { id: "t1", virtual_mcp_id: "vmcp-1" },
      { canInsert: false },
    );
    expect(flatItems(out)).toEqual([]);
  });

  test("patches a row on a later page (not just the first)", () => {
    const existing: TasksQueryData = {
      pages: [
        {
          items: [
            {
              id: "t0",
              title: "Page 1",
              created_at: "2026-05-15T00:00:00Z",
              updated_at: "2026-05-15T00:00:00Z",
            },
          ],
          hasMore: true,
        },
        {
          items: [
            {
              id: "t1",
              title: "Page 2",
              created_at: "2026-05-15T00:00:00Z",
              updated_at: "2026-05-15T00:00:00Z",
            },
          ],
          hasMore: false,
        },
      ],
      pageParams: [0, 50],
    };
    const out = applyPatch(existing, { id: "t1", status: "completed" });
    expect(out?.pages[1]?.items[0]?.status).toBe("completed");
    // First page row left untouched
    expect(out?.pages[0]?.items[0]?.title).toBe("Page 1");
  });
});

describe("getThreadScopeFromKey", () => {
  test("recognizes org scope key", () => {
    expect(getThreadScopeFromKey(KEYS.threads("loc", "org"))).toBe("org");
  });

  test("recognizes agent scope key", () => {
    expect(
      getThreadScopeFromKey(
        KEYS.threads("loc", { kind: "agent", virtualMcpId: "v1" }),
      ),
    ).toEqual({ kind: "agent", virtualMcpId: "v1" });
  });

  test("returns null for unrelated keys sharing the prefix", () => {
    expect(
      getThreadScopeFromKey(["threads", "list-infinite", "loc", "k"]),
    ).toBe(null);
    expect(getThreadScopeFromKey(["threads", "messages", "loc", "t1"])).toBe(
      null,
    );
  });
});

describe("scopeAcceptsRow", () => {
  test("org scope accepts every row, including untagged", () => {
    expect(scopeAcceptsRow("org", "vmcp-1")).toBe(true);
    expect(scopeAcceptsRow("org", undefined)).toBe(true);
  });

  test("agent scope only accepts matching virtual_mcp_id", () => {
    const scope = { kind: "agent" as const, virtualMcpId: "vmcp-1" };
    expect(scopeAcceptsRow(scope, "vmcp-1")).toBe(true);
    expect(scopeAcceptsRow(scope, "vmcp-2")).toBe(false);
    expect(scopeAcceptsRow(scope, undefined)).toBe(false);
  });
});

function seedCaches(
  queryClient: QueryClient,
  locator: string,
  agents: string[],
) {
  queryClient.setQueryData<TasksQueryData>(
    KEYS.threads(locator, "org"),
    pagedData([]),
  );
  for (const v of agents) {
    queryClient.setQueryData<TasksQueryData>(
      KEYS.threads(locator, { kind: "agent", virtualMcpId: v }),
      pagedData([]),
    );
  }
}

describe("patchThreadCaches", () => {
  test("status event for agent A does not insert into agent B's cache", () => {
    const qc = new QueryClient();
    seedCaches(qc, "loc", ["a", "b"]);

    patchThreadCaches(qc, "loc", {
      id: "t1",
      status: "in_progress",
      virtual_mcp_id: "a",
    });

    const agentA = qc.getQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "a" }),
    );
    const agentB = qc.getQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "b" }),
    );
    const org = qc.getQueryData<TasksQueryData>(KEYS.threads("loc", "org"));

    expect(flatItems(agentA).map((t) => t.id)).toEqual(["t1"]);
    expect(flatItems(agentB)).toEqual([]);
    expect(flatItems(org).map((t) => t.id)).toEqual(["t1"]);
  });

  test("event without virtual_mcp_id only lands in org scope", () => {
    const qc = new QueryClient();
    seedCaches(qc, "loc", ["a"]);

    patchThreadCaches(qc, "loc", { id: "t1", status: "in_progress" });

    const agentA = qc.getQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "a" }),
    );
    const org = qc.getQueryData<TasksQueryData>(KEYS.threads("loc", "org"));
    expect(flatItems(agentA)).toEqual([]);
    expect(flatItems(org).map((t) => t.id)).toEqual(["t1"]);
  });

  test("updates of existing rows apply across all scopes that hold them", () => {
    const qc = new QueryClient();
    const row: Task = {
      id: "t1",
      title: "Old",
      created_at: "2026-05-15T00:00:00Z",
      updated_at: "2026-05-15T00:00:00Z",
      virtual_mcp_id: "a",
    };
    qc.setQueryData<TasksQueryData>(
      KEYS.threads("loc", "org"),
      pagedData([row]),
    );
    qc.setQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "a" }),
      pagedData([row]),
    );

    patchThreadCaches(qc, "loc", {
      id: "t1",
      status: "completed",
      virtual_mcp_id: "a",
    });

    const org = qc.getQueryData<TasksQueryData>(KEYS.threads("loc", "org"));
    const agentA = qc.getQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "a" }),
    );
    expect(flatItems(org)[0]?.status).toBe("completed");
    expect(flatItems(agentA)[0]?.status).toBe("completed");
  });
});

describe("prependRowToThreadCaches", () => {
  test("agent-A row only lands in org + agent-A caches", () => {
    const qc = new QueryClient();
    seedCaches(qc, "loc", ["a", "b"]);

    const row: Task = {
      id: "t1",
      title: "Hi",
      created_at: "2026-05-15T00:00:00Z",
      updated_at: "2026-05-15T00:00:00Z",
      virtual_mcp_id: "a",
    };
    prependRowToThreadCaches(qc, "loc", row);

    const agentA = qc.getQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "a" }),
    );
    const agentB = qc.getQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "b" }),
    );
    const org = qc.getQueryData<TasksQueryData>(KEYS.threads("loc", "org"));
    expect(flatItems(agentA).map((t) => t.id)).toEqual(["t1"]);
    expect(flatItems(agentB)).toEqual([]);
    expect(flatItems(org).map((t) => t.id)).toEqual(["t1"]);
  });

  test("dedupes when the row is already cached", () => {
    const qc = new QueryClient();
    const row: Task = {
      id: "t1",
      title: "Hi",
      created_at: "2026-05-15T00:00:00Z",
      updated_at: "2026-05-15T00:00:00Z",
      virtual_mcp_id: "a",
    };
    qc.setQueryData<TasksQueryData>(
      KEYS.threads("loc", "org"),
      pagedData([row]),
    );

    prependRowToThreadCaches(qc, "loc", row);

    const org = qc.getQueryData<TasksQueryData>(KEYS.threads("loc", "org"));
    expect(flatItems(org).length).toBe(1);
  });
});
