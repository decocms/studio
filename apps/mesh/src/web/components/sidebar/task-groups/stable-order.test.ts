import { describe, expect, test } from "bun:test";
import {
  computeGroupOrder,
  canReorderAcrossSections,
  buildStoredOrderAfterReorder,
  partitionDisplayGroups,
  reorderGroupIds,
  sortableGroupIds,
  sortableGroupIdsForSection,
} from "./stable-order";
import { TOOL_CALL_RUNS_GROUP_KEY, type TaskGroupData } from "./group-threads";

const decopilotId = "decopilot-1";

function group(
  virtualMcpId: string,
  threads: TaskGroupData["threads"] = [],
): TaskGroupData {
  return {
    virtualMcpId,
    threads,
    latestUpdatedAt: threads[0]?.updated_at ?? "",
  };
}

describe("sortableGroupIds", () => {
  test("excludes decopilot and automation runs", () => {
    const groups = [
      group(decopilotId),
      group("agent-a"),
      group(TOOL_CALL_RUNS_GROUP_KEY),
    ];
    expect(sortableGroupIds(groups, decopilotId)).toEqual(["agent-a"]);
  });
});

describe("sortableGroupIdsForSection", () => {
  test("splits org-pinned and personal ids", () => {
    const groups = [group("org-a"), group("user-a"), group("org-b")];
    const orgPinnedIds = ["org-a", "org-b"];
    expect(
      sortableGroupIdsForSection(groups, "org", decopilotId, orgPinnedIds),
    ).toEqual(["org-a", "org-b"]);
    expect(
      sortableGroupIdsForSection(groups, "user", decopilotId, orgPinnedIds),
    ).toEqual(["user-a"]);
  });
});

describe("partitionDisplayGroups", () => {
  test("keeps decopilot first and automation runs last in partitions", () => {
    const groups = [
      group(decopilotId),
      group("org-a"),
      group("user-a"),
      group(TOOL_CALL_RUNS_GROUP_KEY),
    ];
    const parts = partitionDisplayGroups(groups, decopilotId, ["org-a"]);
    expect(parts.decopilot?.virtualMcpId).toBe(decopilotId);
    expect(parts.orgPinned.map((g) => g.virtualMcpId)).toEqual(["org-a"]);
    expect(parts.user.map((g) => g.virtualMcpId)).toEqual(["user-a"]);
    expect(parts.toolCallRuns?.virtualMcpId).toBe(TOOL_CALL_RUNS_GROUP_KEY);
  });
});

describe("reorderGroupIds", () => {
  test("moves an id within the list", () => {
    expect(reorderGroupIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  test("returns the same list when ids are missing", () => {
    expect(reorderGroupIds(["a", "b"], "x", "a")).toEqual(["a", "b"]);
  });
});

describe("computeGroupOrder", () => {
  test("pins decopilot first and automation runs last", () => {
    const groups = [
      group("agent-b"),
      group(decopilotId),
      group("agent-a"),
      group(TOOL_CALL_RUNS_GROUP_KEY),
    ];
    const { groups: ordered } = computeGroupOrder(groups, [], decopilotId);
    expect(ordered.map((g) => g.virtualMcpId)).toEqual([
      decopilotId,
      "agent-b",
      "agent-a",
      TOOL_CALL_RUNS_GROUP_KEY,
    ]);
  });

  test("preserves empty personal groups tracked in saved order", () => {
    const savedUserOrder = ["agent-b", "agent-a"];
    const groups = [group(decopilotId), group("agent-a")];
    const { groups: ordered } = computeGroupOrder(
      groups,
      savedUserOrder,
      decopilotId,
    );
    expect(ordered.map((g) => g.virtualMcpId)).toEqual([
      decopilotId,
      "agent-b",
      "agent-a",
    ]);
    expect(ordered.find((g) => g.virtualMcpId === "agent-b")?.threads).toEqual(
      [],
    );
  });

  test("respects a user-defined personal order", () => {
    const groups = [group(decopilotId), group("agent-a"), group("agent-b")];
    const savedUserOrder = ["agent-b", "agent-a"];
    const { groups: ordered } = computeGroupOrder(
      groups,
      savedUserOrder,
      decopilotId,
    );
    expect(ordered.map((g) => g.virtualMcpId)).toEqual([
      decopilotId,
      "agent-b",
      "agent-a",
    ]);
  });

  test("returns no groups when saved order is empty and there are no threads", () => {
    const { groups: ordered } = computeGroupOrder([], [], decopilotId);
    expect(ordered).toEqual([]);
  });

  test("adds a new thread group to empty saved order", () => {
    const thread = {
      id: "t1",
      title: "Task",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      virtual_mcp_id: "agent-a",
    };
    const groups = [group("agent-a", [thread])];
    const { groups: ordered, userOrder } = computeGroupOrder(
      groups,
      [],
      decopilotId,
    );
    expect(ordered.map((g) => g.virtualMcpId)).toEqual(["agent-a"]);
    expect(userOrder).toEqual(["agent-a"]);
  });

  test("places org-pinned agents before personal agents", () => {
    const groups = [group(decopilotId), group("user-a"), group("org-a")];
    const {
      groups: ordered,
      orgOrder,
      userOrder,
    } = computeGroupOrder(groups, ["user-a"], decopilotId, ["org-a"], []);
    expect(ordered.map((g) => g.virtualMcpId)).toEqual([
      decopilotId,
      "org-a",
      "user-a",
    ]);
    expect(orgOrder).toEqual(["org-a"]);
    expect(userOrder).toEqual(["user-a"]);
  });

  test("includes org-pinned agents with no threads", () => {
    const groups = [group(decopilotId)];
    const { groups: ordered, orgOrder } = computeGroupOrder(
      groups,
      [],
      decopilotId,
      ["agent-pinned", "agent-other"],
      [],
    );
    expect(orgOrder).toEqual(["agent-pinned", "agent-other"]);
    expect(ordered.map((g) => g.virtualMcpId)).toEqual([
      decopilotId,
      "agent-pinned",
      "agent-other",
    ]);
    expect(
      ordered.find((g) => g.virtualMcpId === "agent-pinned")?.threads,
    ).toEqual([]);
  });

  test("does not duplicate org-pinned agents still listed in personal order", () => {
    const groups = [group("org-a"), group("user-a")];
    const { groups: ordered } = computeGroupOrder(
      groups,
      ["org-a", "user-a"],
      decopilotId,
      ["org-a"],
      ["org-a"],
    );
    expect(ordered.map((g) => g.virtualMcpId)).toEqual(["org-a", "user-a"]);
  });

  test("prepends new thread groups before saved personal order", () => {
    const groups = [group("agent-new"), group("agent-b")];
    const { groups: ordered } = computeGroupOrder(
      groups,
      ["agent-b"],
      decopilotId,
    );
    expect(ordered.map((g) => g.virtualMcpId)).toEqual([
      "agent-new",
      "agent-b",
    ]);
  });

  test("prepends thread groups missing from saved personal order", () => {
    const groups = [group("agent-x"), group("agent-y")];
    const { groups: ordered } = computeGroupOrder(
      groups,
      ["agent-x"],
      decopilotId,
    );
    expect(ordered.map((g) => g.virtualMcpId)).toEqual(["agent-y", "agent-x"]);
  });

  test("merges org-pinned ids missing from saved org order", () => {
    const groups = [group("org-new")];
    const { orgOrder } = computeGroupOrder(
      groups,
      [],
      decopilotId,
      ["org-new", "org-old"],
      ["org-old"],
    );
    expect(orgOrder).toEqual(["org-old", "org-new"]);
  });
});

describe("reorderGroupIds edge cases", () => {
  test("same index is a no-op", () => {
    expect(reorderGroupIds(["a", "b"], "a", "a")).toEqual(["a", "b"]);
  });
});

describe("buildStoredOrderAfterReorder", () => {
  test("preserves filtered-out tail ids in personal section", () => {
    const stored = buildStoredOrderAfterReorder(
      "user",
      { orgId: "org-1", userId: "user-1" },
      [],
      ["visible-a", "visible-b"],
    );
    expect(stored.slice(0, 2)).toEqual(["visible-a", "visible-b"]);
  });
});

describe("canReorderAcrossSections", () => {
  test("blocks cross-section drags", () => {
    expect(canReorderAcrossSections("org-a", "user-a", ["org-a"])).toBe(false);
    expect(canReorderAcrossSections("user-a", "user-b", ["org-a"])).toBe(true);
  });
});
