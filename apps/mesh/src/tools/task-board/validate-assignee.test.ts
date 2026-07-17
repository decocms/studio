/**
 * Regression coverage: `assertValidAssignee` used to list members with no
 * filter, so it relied on Better Auth's default page (capped at 100 rows) to
 * happen to contain the assignee. In an organization with more than 100
 * members, a legitimate assignee outside that first page was wrongly
 * rejected. The fix filters server-side on the exact userId.
 *
 * `listMembers` is mocked as the single boundary this internal validator
 * calls through (see TESTING.md's narrow one-boundary-mock exception) — the
 * assertion is on the JS behavior (throw vs. not, and the query it issues),
 * not a wire response.
 */
import { describe, expect, it, mock } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { assertValidAssignee } from "./validate-assignee";
import { SUPER_AGENT_ASSIGNEE_ID } from "./schema";

function ctxWithListMembers(
  listMembers: (options?: {
    organizationId?: string;
    filterField?: string;
    filterValue?: string;
  }) => Promise<{ members: { userId: string }[] }>,
): StudioContext {
  return {
    boundAuth: { organization: { listMembers } },
  } as unknown as StudioContext;
}

describe("assertValidAssignee", () => {
  it("resolves when the filtered lookup returns the assignee", async () => {
    const ctx = ctxWithListMembers(async () => ({
      members: [{ userId: "user-101" }],
    }));
    await expect(
      assertValidAssignee(ctx, "org-1", "user-101"),
    ).resolves.toBeUndefined();
  });

  it("accepts the Super Agent sentinel without a membership lookup", async () => {
    const listMembers = mock(async () => ({ members: [] }));
    const ctx = ctxWithListMembers(listMembers);
    await expect(
      assertValidAssignee(ctx, "org-1", SUPER_AGENT_ASSIGNEE_ID),
    ).resolves.toBeUndefined();
    expect(listMembers).not.toHaveBeenCalled();
  });

  it("throws when the filtered lookup returns no match", async () => {
    const ctx = ctxWithListMembers(async () => ({ members: [] }));
    await expect(assertValidAssignee(ctx, "org-1", "user-999")).rejects.toThrow(
      "assigneeId is not a member of the organization",
    );
  });

  it("filters server-side on the exact userId instead of paging every member", async () => {
    const listMembers = mock(async () => ({
      members: [{ userId: "user-101" }],
    }));
    const ctx = ctxWithListMembers(listMembers);
    await assertValidAssignee(ctx, "org-1", "user-101");
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
