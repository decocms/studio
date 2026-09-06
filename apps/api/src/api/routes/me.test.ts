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

  /** INVERTED. A legacy key carrying no organization binding used to fall
   *  through as `null` — unfenced — which on a route that answers across every
   *  membership means a key minted for one org enumerating its owner's other
   *  orgs. A key is a scoped credential; absence of a scope is not consent to
   *  all of them. */
  it("denies a key with no organization binding, rather than unfencing it", () => {
    expect(
      credentialOrganizationFence(
        ctx({ user: { id: "u1" }, apiKey: { id: "k1", metadata: {} } }),
      ),
    ).toBe(DENY);
  });

  /** A SESSION is the person, and this route is that person's own data across
   *  their memberships — so no binding here means no fence, as before. */
  it("leaves a session caller unfenced", () => {
    expect(credentialOrganizationFence(ctx({ user: { id: "u1" } }))).toBeNull();
  });
});
