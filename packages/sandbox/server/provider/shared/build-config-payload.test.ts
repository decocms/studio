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
});
