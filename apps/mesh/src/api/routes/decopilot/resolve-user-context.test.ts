import { describe, expect, test } from "bun:test";
import { resolveUserContext } from "./dispatch-run";

const ctx = {
  auth: { user: { id: "u1", name: "Ada", email: "ada@example.com" } },
  storage: {
    threads: {
      list: async () => ({
        total: 2,
        threads: [
          { id: "t1", title: "Old", updated_at: "2026-06-01T00:00:00Z" },
          { id: "t2", title: "Older", updated_at: "2026-05-30T00:00:00Z" },
        ],
      }),
    },
    interests: {
      getForAgent: async () => ({
        interests: [{ title: "Ship harness", summary: "extract pkg" }],
      }),
    },
    virtualMcps: {
      list: async () => [
        {
          id: "vir_b",
          title: "Agent B",
          description: "sibling",
          status: "active",
        },
      ],
    },
  },
} as never;

describe("resolveUserContext", () => {
  test("maps storage rows into a serializable HarnessUserContext", async () => {
    const out = await resolveUserContext(ctx, "org1", "vir_a", "u1");
    expect(out?.recentThreads?.total).toBe(2);
    expect(out?.recentThreads?.threads[0]).toEqual({
      id: "t1",
      title: "Old",
      updated_at: "2026-06-01T00:00:00Z",
    });
    expect(out?.interests).toEqual([
      { title: "Ship harness", summary: "extract pkg" },
    ]);
    expect(out?.agents).toEqual([
      {
        id: "vir_b",
        name: "Agent B",
        description: "sibling",
        status: "active",
      },
    ]);
  });

  test("returns undefined sub-blocks gracefully when reads fail", async () => {
    const failing = {
      auth: { user: { id: "u1" } },
      storage: {
        threads: {
          list: async () => {
            throw new Error("db down");
          },
        },
        interests: {
          getForAgent: async () => {
            throw new Error("db down");
          },
        },
        virtualMcps: {
          list: async () => {
            throw new Error("db down");
          },
        },
      },
    } as never;
    const out = await resolveUserContext(failing, "org1", "vir_a", "u1");
    expect(out).toEqual({});
  });
});
