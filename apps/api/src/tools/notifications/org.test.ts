import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { requireOrg, requireTaskInOrg } from "./org";

function ctxWithTask(
  organizationId: string | undefined,
  task: { organizationId: string } | null,
): StudioContext {
  return {
    organization: organizationId ? { id: organizationId } : undefined,
    storage: {
      taskBoard: {
        getById: async (_id: string, lookupOrgId: string) =>
          task && task.organizationId === lookupOrgId ? { id: _id } : null,
      },
    },
  } as unknown as StudioContext;
}

describe("requireOrg", () => {
  test("returns the caller's organization id", () => {
    expect(requireOrg(ctxWithTask("org_1", null))).toBe("org_1");
  });

  test("throws when there is no active organization", () => {
    expect(() => requireOrg(ctxWithTask(undefined, null))).toThrow();
  });
});

describe("requireTaskInOrg", () => {
  test("resolves when the task belongs to the caller's organization", async () => {
    const ctx = ctxWithTask("org_1", { organizationId: "org_1" });
    await expect(requireTaskInOrg(ctx, "task_1")).resolves.toBe("org_1");
  });

  // Cross-tenant guard: a task scoped to another org must not resolve here.
  test("rejects a task that belongs to a different organization", async () => {
    const ctx = ctxWithTask("org_1", { organizationId: "org_2" });
    await expect(requireTaskInOrg(ctx, "task_1")).rejects.toThrow(
      "Task board item not found",
    );
  });

  test("rejects when the task does not exist at all", async () => {
    const ctx = ctxWithTask("org_1", null);
    await expect(requireTaskInOrg(ctx, "missing")).rejects.toThrow(
      "Task board item not found",
    );
  });
});
