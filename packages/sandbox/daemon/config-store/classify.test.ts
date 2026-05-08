import { describe, expect, it } from "bun:test";
import type { TenantConfig } from "../types";
import { classify } from "./classify";

const baseApp: NonNullable<TenantConfig["application"]> = {
  packageManager: { name: "npm" },
  runtime: "node",
};

describe("classify", () => {
  it("null → null = no-op", () => {
    expect(classify(null, {}).kind).toBe("no-op");
  });

  it("null → meaningful (cloneUrl) = bootstrap", () => {
    const after: TenantConfig = {
      git: { repository: { cloneUrl: "https://x.git" } },
    };
    expect(classify(null, after).kind).toBe("bootstrap");
  });

  it("null → meaningful (application only) = bootstrap", () => {
    const after: TenantConfig = { application: baseApp };
    expect(classify(null, after).kind).toBe("bootstrap");
  });

  it("cloneUrl mismatch (different repo) = identity-conflict", () => {
    const before: TenantConfig = {
      git: { repository: { cloneUrl: "https://github.com/org/repo-a.git" } },
    };
    const after: TenantConfig = {
      git: { repository: { cloneUrl: "https://github.com/org/repo-b.git" } },
    };
    expect(classify(before, after).kind).toBe("identity-conflict");
  });

  it("cloneUrl credential-only change (refreshed OAuth token) = not identity-conflict", () => {
    const before: TenantConfig = {
      git: {
        repository: {
          cloneUrl: "https://x-access-token:OLD_TOKEN@github.com/org/repo.git",
        },
      },
    };
    const after: TenantConfig = {
      git: {
        repository: {
          cloneUrl: "https://x-access-token:NEW_TOKEN@github.com/org/repo.git",
        },
      },
    };
    expect(classify(before, after).kind).not.toBe("identity-conflict");
  });

  it("branch change = branch-change", () => {
    const before: TenantConfig = {
      git: { repository: { cloneUrl: "x", branch: "main" } },
    };
    const after: TenantConfig = {
      git: { repository: { cloneUrl: "x", branch: "feature" } },
    };
    const t = classify(before, after);
    expect(t.kind).toBe("branch-change");
    if (t.kind === "branch-change") {
      expect(t.from).toBe("main");
      expect(t.to).toBe("feature");
    }
  });

  it("runtime change without pm = runtime-change", () => {
    const before: TenantConfig = {
      application: { ...baseApp, runtime: "node" },
    };
    const after: TenantConfig = {
      application: { ...baseApp, runtime: "bun" },
    };
    expect(classify(before, after).kind).toBe("runtime-change");
  });

  it("pm name change = pm-change", () => {
    const before: TenantConfig = { application: baseApp };
    const after: TenantConfig = {
      application: { ...baseApp, packageManager: { name: "pnpm" } },
    };
    expect(classify(before, after).kind).toBe("pm-change");
  });

  it("pm path change = pm-change", () => {
    const before: TenantConfig = {
      application: { ...baseApp, packageManager: { name: "npm" } },
    };
    const after: TenantConfig = {
      application: {
        ...baseApp,
        packageManager: { name: "npm", path: "apps/web" },
      },
    };
    expect(classify(before, after).kind).toBe("pm-change");
  });

  it("port change = port-change", () => {
    const before: TenantConfig = {
      application: { ...baseApp, port: 3000 },
    };
    const after: TenantConfig = {
      application: { ...baseApp, port: 5173 },
    };
    expect(classify(before, after).kind).toBe("port-change");
  });

  it("identical configs = no-op", () => {
    const config: TenantConfig = { application: baseApp };
    expect(classify(config, config).kind).toBe("no-op");
  });

  it("branch + pm change emits the higher-impact one (branch-change)", () => {
    const before: TenantConfig = {
      git: { repository: { cloneUrl: "x", branch: "main" } },
      application: baseApp,
    };
    const after: TenantConfig = {
      git: { repository: { cloneUrl: "x", branch: "feature" } },
      application: { ...baseApp, packageManager: { name: "pnpm" } },
    };
    expect(classify(before, after).kind).toBe("branch-change");
  });
});
