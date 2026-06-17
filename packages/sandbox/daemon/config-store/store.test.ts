import { describe, expect, it } from "bun:test";
import { TenantConfigStore } from "./store";

describe("TenantConfigStore", () => {
  it("persists git credential refresh and notifies subscribers", async () => {
    const store = new TenantConfigStore();
    await store.apply({
      git: {
        repository: {
          cloneUrl: "https://x-access-token:OLD@github.com/org/repo.git",
        },
      },
      application: { packageManager: { name: "npm" }, runtime: "node" },
    });

    const transitions: string[] = [];
    store.subscribe((e) => transitions.push(e.transition.kind));

    const result = await store.apply({
      git: {
        repository: {
          cloneUrl: "https://x-access-token:NEW@github.com/org/repo.git",
        },
      },
    });

    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.transition.kind).toBe("git-credential-refresh");
    }
    expect(store.read()?.git?.repository?.cloneUrl).toBe(
      "https://x-access-token:NEW@github.com/org/repo.git",
    );
    expect(transitions).toContain("git-credential-refresh");
  });
});
