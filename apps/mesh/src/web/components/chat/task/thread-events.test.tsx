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

const emptyData: TasksQueryData = { items: [], hasMore: false };

describe("applyPatch", () => {
  test("synthetic row carries created_by and trigger_id when provided", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "in_progress",
      updated_at: "2026-05-15T00:00:00Z",
    });
    expect(out?.items[0]).toMatchObject({
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
    expect(out?.items[0]?.trigger_id).toBeNull();
  });

  test("patching an existing row does not clobber created_by / trigger_id when undefined", () => {
    const existing: TasksQueryData = {
      items: [
        {
          id: "t1",
          title: "Existing",
          created_at: "2026-05-15T00:00:00Z",
          updated_at: "2026-05-15T00:00:00Z",
          created_by: "user-1",
          trigger_id: "trig-1",
        },
      ],
      hasMore: false,
    };
    const out = applyPatch(existing, { id: "t1", status: "completed" });
    expect(out?.items[0]).toMatchObject({
      created_by: "user-1",
      trigger_id: "trig-1",
      status: "completed",
    });
  });

  test("patching can update trigger_id when explicitly carried", () => {
    const existing: TasksQueryData = {
      items: [
        {
          id: "t1",
          title: "Existing",
          created_at: "2026-05-15T00:00:00Z",
          updated_at: "2026-05-15T00:00:00Z",
          trigger_id: null,
        },
      ],
      hasMore: false,
    };
    const out = applyPatch(existing, { id: "t1", trigger_id: "trig-1" });
    expect(out?.items[0]?.trigger_id).toBe("trig-1");
  });

  test("synthetic row carries virtual_mcp_id when provided (so the agent icon renders on SSE-inserted rows)", () => {
    const out = applyPatch(emptyData, {
      id: "t1",
      virtual_mcp_id: "vmcp-1",
      status: "in_progress",
      updated_at: "2026-05-15T00:00:00Z",
    });
    expect(out?.items[0]?.virtual_mcp_id).toBe("vmcp-1");
  });

  test("patching an existing row does not clobber virtual_mcp_id when undefined", () => {
    const existing: TasksQueryData = {
      items: [
        {
          id: "t1",
          title: "Existing",
          created_at: "2026-05-15T00:00:00Z",
          updated_at: "2026-05-15T00:00:00Z",
          virtual_mcp_id: "vmcp-1",
        },
      ],
      hasMore: false,
    };
    const out = applyPatch(existing, { id: "t1", status: "completed" });
    expect(out?.items[0]?.virtual_mcp_id).toBe("vmcp-1");
  });

  test("canInsert:false skips synthetic insert for missing row", () => {
    const out = applyPatch(
      emptyData,
      { id: "t1", virtual_mcp_id: "vmcp-1" },
      { canInsert: false },
    );
    expect(out?.items).toEqual([]);
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
  queryClient.setQueryData<TasksQueryData>(KEYS.threads(locator, "org"), {
    items: [],
    hasMore: false,
  });
  for (const v of agents) {
    queryClient.setQueryData<TasksQueryData>(
      KEYS.threads(locator, { kind: "agent", virtualMcpId: v }),
      { items: [], hasMore: false },
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

    expect(agentA?.items.map((t) => t.id)).toEqual(["t1"]);
    expect(agentB?.items).toEqual([]);
    expect(org?.items.map((t) => t.id)).toEqual(["t1"]);
  });

  test("event without virtual_mcp_id only lands in org scope", () => {
    const qc = new QueryClient();
    seedCaches(qc, "loc", ["a"]);

    patchThreadCaches(qc, "loc", { id: "t1", status: "in_progress" });

    const agentA = qc.getQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "a" }),
    );
    const org = qc.getQueryData<TasksQueryData>(KEYS.threads("loc", "org"));
    expect(agentA?.items).toEqual([]);
    expect(org?.items.map((t) => t.id)).toEqual(["t1"]);
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
    qc.setQueryData<TasksQueryData>(KEYS.threads("loc", "org"), {
      items: [row],
      hasMore: false,
    });
    qc.setQueryData<TasksQueryData>(
      KEYS.threads("loc", { kind: "agent", virtualMcpId: "a" }),
      { items: [row], hasMore: false },
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
    expect(org?.items[0]?.status).toBe("completed");
    expect(agentA?.items[0]?.status).toBe("completed");
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
    expect(agentA?.items.map((t) => t.id)).toEqual(["t1"]);
    expect(agentB?.items).toEqual([]);
    expect(org?.items.map((t) => t.id)).toEqual(["t1"]);
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
    qc.setQueryData<TasksQueryData>(KEYS.threads("loc", "org"), {
      items: [row],
      hasMore: false,
    });

    prependRowToThreadCaches(qc, "loc", row);

    const org = qc.getQueryData<TasksQueryData>(KEYS.threads("loc", "org"));
    expect(org?.items.length).toBe(1);
  });
});
