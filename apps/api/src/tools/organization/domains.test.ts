import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_DOMAIN_ADD } from "./domains";

function makeCtx(claimedCount: number) {
  const claimed = Array.from({ length: claimedCount }, (_, i) => ({
    id: `domain-${i}`,
  }));

  return {
    auth: { user: { id: "user-1", email: "dev@example.com" } },
    organization: { id: "org-a" },
    access: { check: mock(async () => {}) },
    storage: {
      organizationDomains: {
        getByOrgAndDomain: mock(async () => null),
        listByOrganizationId: mock(async () => claimed),
        add: mock(async (organizationId: string, domain: string) => ({
          id: "new-domain",
          organizationId,
          domain,
          joinMode: "off",
          verificationStatus: "pending",
          verificationMethod: null,
          verificationToken: "tok",
          verifiedAt: null,
        })),
      },
    },
  } as unknown as Parameters<typeof ORGANIZATION_DOMAIN_ADD.handler>[1];
}

describe("ORGANIZATION_DOMAIN_ADD", () => {
  it("rejects a new domain once the org is at the cap", async () => {
    const ctx = makeCtx(50);

    await expect(
      ORGANIZATION_DOMAIN_ADD.handler({ domain: "acme.com" }, ctx),
    ).rejects.toThrow(/at most 50 domains/i);

    expect(
      (
        ctx as unknown as {
          storage: { organizationDomains: { add: ReturnType<typeof mock> } };
        }
      ).storage.organizationDomains.add,
    ).not.toHaveBeenCalled();
  });

  it("allows a new domain below the cap", async () => {
    const ctx = makeCtx(49);

    const result = await ORGANIZATION_DOMAIN_ADD.handler(
      { domain: "acme.com" },
      ctx,
    );

    expect(result.domain).toBe("acme.com");
  });
});
