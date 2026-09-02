import { describe, expect, it } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { credentialOrganizationFence, DENY } from "./me";

/** Build just the auth slice the fence reads. */
function ctx(auth: unknown): StudioContext {
  return { auth } as unknown as StudioContext;
}

describe("credentialOrganizationFence", () => {
  it("lets a session user read every organization they belong to", () => {
    expect(credentialOrganizationFence(ctx({ user: { id: "u1" } }))).toBeNull();
  });

  it("confines an org-bound API key to the organization that minted it", () => {
    const fence = credentialOrganizationFence(
      ctx({
        user: { id: "u1" },
        apiKey: { id: "k1", metadata: { organization: { id: "org_a" } } },
      }),
    );
    expect(fence).toBe("org_a");
  });

  it("confines an org-scoped token to its organization", () => {
    expect(
      credentialOrganizationFence(
        ctx({ user: { id: "u1" }, tokenOrganizationId: "org_b" }),
      ),
    ).toBe("org_b");
  });

  /** The same fail-closed rule resolveOrgFromPath applies: an explicit but
   *  unreadable binding must not fall through to the unfenced path. */
  it("denies an API key whose organization binding is present but malformed", () => {
    expect(
      credentialOrganizationFence(
        ctx({
          user: { id: "u1" },
          apiKey: { id: "k1", metadata: { organization: 42 } },
        }),
      ),
    ).toBe(DENY);
    expect(
      credentialOrganizationFence(
        ctx({
          user: { id: "u1" },
          apiKey: { id: "k1", metadata: { organization: { id: 7 } } },
        }),
      ),
    ).toBe(DENY);
  });

  it("denies when a key and a token name different organizations", () => {
    expect(
      credentialOrganizationFence(
        ctx({
          user: { id: "u1" },
          apiKey: { id: "k1", metadata: { organization: { id: "org_a" } } },
          tokenOrganizationId: "org_b",
        }),
      ),
    ).toBe(DENY);
  });

  /** A legacy key carrying no organization binding at all keeps its existing
   *  route authorization rather than being denied outright. */
  it("does not fence a key with no organization binding", () => {
    expect(
      credentialOrganizationFence(
        ctx({ user: { id: "u1" }, apiKey: { id: "k1", metadata: {} } }),
      ),
    ).toBeNull();
  });
});
