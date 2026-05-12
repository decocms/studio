import { describe, expect, mock, test } from "bun:test";
import { ensureStudioPackForAllOrgs } from "./ensure-studio-pack";

describe("ensureStudioPackForAllOrgs", () => {
  test("calls installer once per org, using the org's first owner as createdBy", async () => {
    const calls: Array<{ orgId: string; createdBy: string }> = [];
    const installer = mock(async (orgId: string, createdBy: string) => {
      calls.push({ orgId, createdBy });
    });
    const orgs = [
      { id: "org_a", createdBy: "user_a" },
      { id: "org_b", createdBy: "user_b" },
    ];
    await ensureStudioPackForAllOrgs({
      listOrgs: async () => orgs,
      installer,
      virtualMcpStorage: null as never,
    });

    // Sort so the assertion isn't sensitive to Promise.all ordering.
    expect(calls.sort((a, b) => a.orgId.localeCompare(b.orgId))).toEqual([
      { orgId: "org_a", createdBy: "user_a" },
      { orgId: "org_b", createdBy: "user_b" },
    ]);
  });

  test("surfaces but does not throw on a single org failure", async () => {
    const failures: unknown[] = [];
    const installer = mock(async (orgId: string) => {
      if (orgId === "org_b") throw new Error("boom");
    });
    const orgs = [
      { id: "org_a", createdBy: "user_a" },
      { id: "org_b", createdBy: "user_b" },
      { id: "org_c", createdBy: "user_c" },
    ];

    await ensureStudioPackForAllOrgs({
      listOrgs: async () => orgs,
      installer,
      virtualMcpStorage: null as never,
      onError: (orgId, err) => failures.push({ orgId, err }),
    });

    expect(failures.length).toBe(1);
    expect((failures[0] as { orgId: string }).orgId).toBe("org_b");
  });
});
