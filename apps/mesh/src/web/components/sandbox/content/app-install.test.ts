import { describe, expect, it } from "bun:test";
import {
  buildInstallWrites,
  buildUninstallPaths,
  resolveInstallBlockKey,
  appInstallCommitMessage,
} from "./app-install";

describe("app-install", () => {
  it("buildInstallWrites creates shim + block for store apps", () => {
    expect(buildInstallWrites({ vendor: "deco", app: "vtex" })).toEqual([
      {
        path: "apps/deco/vtex.ts",
        content:
          'export { default } from "apps/vtex/mod.ts";\nexport * from "apps/vtex/mod.ts";\n',
      },
      {
        path: ".deco/blocks/deco-vtex.json",
        content: JSON.stringify(
          { __resolveType: "site/apps/deco/vtex.ts" },
          null,
          2,
        ),
      },
    ]);
  });

  it("buildInstallWrites only creates a block for decohub apps", () => {
    const writes = buildInstallWrites({ vendor: "decohub", app: "blog" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(".deco/blocks/blog.json");
    expect(JSON.parse(writes[0]?.content ?? "{}")).toEqual({
      __resolveType: "decohub/apps/blog.ts",
    });
  });

  it("buildUninstallPaths removes shim for modern apps", () => {
    expect(
      buildUninstallPaths({ vendor: "deco", app: "vtex" }, "deco-vtex", {
        __resolveType: "site/apps/deco/vtex.ts",
      }),
    ).toEqual([".deco/blocks/deco-vtex.json", "apps/deco/vtex.ts"]);
  });

  it("buildUninstallPaths only removes block for decohub apps", () => {
    expect(
      buildUninstallPaths({ vendor: "decohub", app: "blog" }, "blog", {
        __resolveType: "decohub/apps/blog.ts",
      }),
    ).toEqual([".deco/blocks/blog.json"]);
  });

  it("resolveInstallBlockKey follows admin block id conventions", () => {
    expect(resolveInstallBlockKey({ vendor: "deco", app: "vtex" })).toBe(
      "deco-vtex",
    );
    expect(resolveInstallBlockKey({ vendor: "decohub", app: "blog" })).toBe(
      "blog",
    );
  });
});

describe("appInstallCommitMessage", () => {
  it("uses conventional commit format for install/uninstall", () => {
    expect(
      appInstallCommitMessage("install", { vendor: "deco", app: "shopify" }),
    ).toBe("feat(apps): install shopify");
    expect(
      appInstallCommitMessage("uninstall", { vendor: "deco", app: "shopify" }),
    ).toBe("feat(apps): uninstall shopify");
  });
});
