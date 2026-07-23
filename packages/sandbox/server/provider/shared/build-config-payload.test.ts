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

  it("returns operator-only payload when repo and application are absent", () => {
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
    });
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

  it("omits submoduleCredentials when the array is empty", () => {
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

    expect(payload?.git?.repository).not.toHaveProperty("submoduleCredentials");
  });
});
