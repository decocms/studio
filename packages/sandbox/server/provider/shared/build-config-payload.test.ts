import { describe, expect, it } from "bun:test";
import { buildConfigPayload } from "./build-config-payload";

describe("buildConfigPayload", () => {
  it("maps tenant identity to operator", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: null,
      tenant: {
        orgId: "org",
        userId: "user",
        userName: " Jane Doe ",
        userEmail: " jane@example.com ",
      },
    });

    expect(payload?.operator).toEqual({
      userName: "Jane Doe",
      userEmail: "jane@example.com",
    });
  });

  it("returns identity and org only, when repo and application are absent", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: null,
      tenant: {
        orgId: "org",
        userId: "user",
        userName: "Jane Doe",
      },
    });

    expect(payload).toEqual({
      operator: { userName: "Jane Doe" },
      orgId: "org",
    });
  });

  it("forwards orgId, which the golden cache keys shared archives by", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: null,
      tenant: { orgId: "org_abc123", userId: "user" },
    });

    // Previously this case produced null: with no repo, no application and no
    // co-author identity there was nothing worth sending. The org alone is now
    // worth sending, because without it the daemon cannot stamp which org
    // produced a cached dependency tree and a cross-node cache cannot isolate
    // two orgs cloning the same public template.
    expect(payload).toEqual({ orgId: "org_abc123" });
  });

  it("omits orgId when there is no tenant", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      // A tenant warm pool bootstraps with a repo and no author, which is also
      // the only way to reach this function with no tenant at all.
      repo: {
        cloneUrl: "https://github.com/acme/site.git",
        userName: "",
        userEmail: "",
      },
    });

    expect(payload).not.toHaveProperty("orgId");
  });

  it("builds git.repository from a repo and derives repoName from the clone URL", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: {
        cloneUrl: "https://github.com/acme/widgets.git",
        userName: "Jane",
        userEmail: "jane@example.com",
        branch: "main",
      },
    });

    expect(payload?.git?.repository).toEqual({
      cloneUrl: "https://github.com/acme/widgets.git",
      repoName: "acme/widgets",
      branch: "main",
      // Always present, even with nothing configured — see the revocation tests.
      submoduleCredentials: [],
    });
  });

  it("forwards submoduleCredentials into git.repository when present", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: {
        cloneUrl: "https://github.com/acme/widgets.git",
        userName: "Jane",
        userEmail: "jane@example.com",
        submoduleCredentials: [{ host: "github.com", token: "ghp_x" }],
      },
    });

    expect(payload?.git?.repository.submoduleCredentials).toEqual([
      { host: "github.com", token: "ghp_x" },
    ]);
  });

  // Inverted deliberately: this used to omit the key, which the daemon reads as
  // "keep current" — so deleting your last credential row never revoked the PAT
  // on a live pod, and a re-bootstrapped pod kept the previous config's tokens.
  it("sends an empty submoduleCredentials array so a deletion revokes", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: {
        cloneUrl: "https://github.com/acme/widgets.git",
        userName: "Jane",
        userEmail: "jane@example.com",
        submoduleCredentials: [],
      },
    });

    expect(payload?.git?.repository.submoduleCredentials).toEqual([]);
  });

  it("sends an empty array when the caller omits the field entirely", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: {
        cloneUrl: "https://github.com/acme/widgets.git",
        userName: "Jane",
        userEmail: "jane@example.com",
      },
    });

    expect(payload?.git?.repository.submoduleCredentials).toEqual([]);
  });
});
