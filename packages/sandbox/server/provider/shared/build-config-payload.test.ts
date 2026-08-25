import { describe, expect, it } from "bun:test";
import { buildConfigPayload, extraRepoDirNames } from "./build-config-payload";

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

  it("sends cloneOnly: false even with no repo/application/tenant, so a warm-pool pod's stale cloneOnly clears", () => {
    const payload = buildConfigPayload({
      runtime: "node",
      packageManager: null,
      repo: null,
      cloneOnly: false,
    });

    expect(payload).toEqual({ cloneOnly: false });
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

const url = (path: string) =>
  `https://x-access-token:tok@github.com/${path}.git`;

describe("extraRepoDirNames", () => {
  it("uses the repo's own name, never the owner/name label", () => {
    expect(extraRepoDirNames([url("acme/storefront")])).toEqual(["storefront"]);
  });

  it("disambiguates a colliding name across owners", () => {
    expect(
      extraRepoDirNames([url("acme/checkout"), url("other/checkout")]),
    ).toEqual(["acme-checkout", "other-checkout"]);
  });

  it("leaves a non-colliding neighbour alone", () => {
    expect(
      extraRepoDirNames([
        url("acme/checkout"),
        url("other/checkout"),
        url("acme/storefront"),
      ]),
    ).toEqual(["acme-checkout", "other-checkout", "storefront"]);
  });

  it("keeps one name per input, in order", () => {
    const urls = [url("a/one"), url("b/two"), url("c/three")];
    expect(extraRepoDirNames(urls)).toEqual(["one", "two", "three"]);
  });

  // Matches the daemon's `repoNameRe`, which rejects separators and dot-opens.
  it("produces names the daemon accepts", () => {
    const names = extraRepoDirNames([
      url("acme/.hidden"),
      url("acme/weird name!"),
      "not-a-url",
    ]);
    for (const name of names) {
      expect(name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    }
  });

  it("has nothing to name for no extras", () => {
    expect(extraRepoDirNames([])).toEqual([]);
  });
});
