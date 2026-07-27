import { describe, it, expect } from "bun:test";
import {
  PACKAGE_MANAGER_CONFIG,
  type PackageManager,
} from "./runtime-defaults";

describe("PACKAGE_MANAGER_CONFIG", () => {
  it("has entries for all 5 package managers", () => {
    const pms: PackageManager[] = ["npm", "pnpm", "yarn", "bun", "deno"];
    for (const pm of pms) {
      expect(PACKAGE_MANAGER_CONFIG[pm]).toBeDefined();
      expect(PACKAGE_MANAGER_CONFIG[pm].install).toBeString();
      expect(PACKAGE_MANAGER_CONFIG[pm].run("dev")).toBeString();
      expect(PACKAGE_MANAGER_CONFIG[pm].runtime).toBeString();
    }
  });

  it("npm maps to node runtime", () => {
    expect(PACKAGE_MANAGER_CONFIG.npm.runtime).toBe("node");
    expect(PACKAGE_MANAGER_CONFIG.npm.install).toBe("npm install");
    expect(PACKAGE_MANAGER_CONFIG.npm.run("dev")).toBe("npm run dev");
  });

  it("pnpm maps to node runtime", () => {
    expect(PACKAGE_MANAGER_CONFIG.pnpm.runtime).toBe("node");
    expect(PACKAGE_MANAGER_CONFIG.pnpm.install).toBe("pnpm install");
    expect(PACKAGE_MANAGER_CONFIG.pnpm.run("test")).toBe("pnpm run test");
  });

  it("yarn maps to node runtime", () => {
    expect(PACKAGE_MANAGER_CONFIG.yarn.runtime).toBe("node");
    expect(PACKAGE_MANAGER_CONFIG.yarn.install).toBe("yarn install");
    expect(PACKAGE_MANAGER_CONFIG.yarn.run("build")).toBe("yarn run build");
  });

  it("bun maps to bun runtime", () => {
    expect(PACKAGE_MANAGER_CONFIG.bun.runtime).toBe("bun");
    expect(PACKAGE_MANAGER_CONFIG.bun.install).toBe("bun install");
    expect(PACKAGE_MANAGER_CONFIG.bun.run("dev")).toBe("bun run dev");
  });

  it("deno maps to deno runtime", () => {
    expect(PACKAGE_MANAGER_CONFIG.deno.runtime).toBe("deno");
    expect(PACKAGE_MANAGER_CONFIG.deno.install).toBe("deno install");
    expect(PACKAGE_MANAGER_CONFIG.deno.run("start")).toBe("deno task start");
  });
});
