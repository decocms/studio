/**
 * Regression coverage: `resolveValidAssignee` (née `assertValidAssignee`) used
 * to list members with no filter, so it relied on Better Auth's default page
 * (capped at 100 rows) to happen to contain the assignee. In an organization
 * with more than 100 members, a legitimate assignee outside that first page was
 * wrongly rejected. The fix filters server-side on the exact userId.
 *
 * Also covers agent delegation: the Super Agent sentinel and code agents
 * (Virtual MCPs backed by a GitHub repo) are valid assignees that resolve to a
 * `DelegatedAgent` (the id to dispatch), while non-code agents and non-members
 * are rejected.
 *
 * `listMembers` and `virtualMcps.findById` are mocked as the two boundaries
 * this internal validator calls through (see TESTING.md's narrow
 * one-boundary-mock exception) — assertions are on the JS behavior (throw vs.
 * not, what it returns, and the query it issues), not a wire response.
 */
import { describe, expect, it, mock } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { resolveValidAssignee } from "./resolve-assignee";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";

type Member = { userId: string };

function makeCtx({
  listMembers = async () => ({ members: [] as Member[] }),
  findById = async () => null,
}: {
  listMembers?: (options?: {
    organizationId?: string;
    filterField?: string;
    filterValue?: string;
  }) => Promise<{ members: Member[] }>;
  findById?: (id: string, organizationId?: string) => Promise<unknown>;
} = {}): StudioContext {
  return {
    boundAuth: { organization: { listMembers } },
    storage: { virtualMcps: { findById } },
  } as unknown as StudioContext;
}

describe("resolveValidAssignee", () => {
  it("returns null (a valid human member) when the filtered lookup finds them", async () => {
    const ctx = makeCtx({
      listMembers: async () => ({ members: [{ userId: "user-101" }] }),
    });
    await expect(
      resolveValidAssignee(ctx, "org-1", "user-101"),
    ).resolves.toBeNull();
  });

  it("resolves the Super Agent sentinel to a delegated agent without a membership lookup", async () => {
    const listMembers = mock(async () => ({ members: [] as Member[] }));
    const findById = mock(async () => null);
    const ctx = makeCtx({ listMembers, findById });
    const agent = await resolveValidAssignee(
      ctx,
      "org-1",
      SUPER_AGENT_ASSIGNEE_ID,
    );
    expect(agent).toEqual({ id: "decopilot_org-1", title: "Super Agent" });
    expect(listMembers).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it("resolves a code agent (repo-backed vMCP owned by the org) to itself", async () => {
    const listMembers = mock(async () => ({ members: [] as Member[] }));
    const ctx = makeCtx({
      listMembers,
      findById: async () => ({
        id: "vmcp-1",
        title: "Repo Bot",
        organization_id: "org-1",
        metadata: { githubRepo: { url: "https://github.com/acme/app" } },
      }),
    });
    const agent = await resolveValidAssignee(ctx, "org-1", "vmcp-1");
    expect(agent).toEqual({ id: "vmcp-1", title: "Repo Bot" });
    // A resolved agent short-circuits before the membership check.
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("treats a vMCP without a clonable repo as a non-agent (falls through to member check)", async () => {
    const ctx = makeCtx({
      findById: async () => ({
        id: "vmcp-2",
        title: "Plain Agent",
        organization_id: "org-1",
        metadata: {},
      }),
    });
    await expect(resolveValidAssignee(ctx, "org-1", "vmcp-2")).rejects.toThrow(
      "assigneeId is not a member of the organization",
    );
  });

  it("does not delegate to a code agent owned by another org", async () => {
    const ctx = makeCtx({
      findById: async () => ({
        id: "vmcp-3",
        title: "Other Org Bot",
        organization_id: "org-2",
        metadata: { githubRepo: { url: "https://github.com/acme/app" } },
      }),
    });
    await expect(resolveValidAssignee(ctx, "org-1", "vmcp-3")).rejects.toThrow(
      "assigneeId is not a member of the organization",
    );
  });

  it("throws when the filtered lookup returns no match", async () => {
    const ctx = makeCtx({ listMembers: async () => ({ members: [] }) });
    await expect(
      resolveValidAssignee(ctx, "org-1", "user-999"),
    ).rejects.toThrow("assigneeId is not a member of the organization");
  });

  it("filters server-side on the exact userId instead of paging every member", async () => {
    const listMembers = mock(async () => ({
      members: [{ userId: "user-101" }],
    }));
    const ctx = makeCtx({ listMembers });
    await resolveValidAssignee(ctx, "org-1", "user-101");
    // Without this filter, an org with >100 members could hide a valid
    // assignee behind Better Auth's default page and this call would wrongly
    // throw — see the docstring above.
    expect(listMembers).toHaveBeenCalledWith({
      organizationId: "org-1",
      filterField: "userId",
      filterValue: "user-101",
    });
  });
});
