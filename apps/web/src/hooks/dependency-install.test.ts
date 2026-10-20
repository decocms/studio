import { describe, expect, it } from "bun:test";
import { findSiteApp, makeInstallAppPatches } from "@decocms/shared/site-apps";
import { dependencyInstallFor } from "./dependency-install";

const PACKAGE_JSON = `{
  "dependencies": {
    "@decocms/blocks": "^7.80.0"
  }
}
`;
const SETUP_TS = `import { autoconfigApps } from "@decocms/blocks-admin/apps";

const APP_REGISTRY = [];
`;

const tanstack = (packageJson: string) =>
  makeInstallAppPatches({
    technology: "tanstack",
    entry: findSiteApp("tanstack", "deco-blog")!,
    decocmsVersion: "^7.80.0",
    packageJson,
    setupTs: SETUP_TS,
  });

describe("dependencyInstallFor", () => {
  it("asks for nothing on Deno", () => {
    const patches = makeInstallAppPatches({
      technology: "deno",
      entry: findSiteApp("deno", "deco-vtex")!,
    });
    expect(dependencyInstallFor(patches)).toBeNull();
  });

  it("forces when the patches rewrite package.json", () => {
    expect(dependencyInstallFor(tanstack(PACKAGE_JSON))).toEqual({
      force: true,
    });
  });

  it("does not force when the dependency is already declared", () => {
    // Reinstalling the same app writes no manifest. Forcing here would stop a
    // healthy dev server and reinstall a tree that did not move.
    const declared = tanstack(PACKAGE_JSON).files.find(
      (file) => file.path === "package.json",
    )!.content;
    const patches = tanstack(declared);

    expect(patches.dependency).toBe("@decocms/apps-blog");
    expect(
      patches.files.some((file) => file.path === "package.json"),
    ).toBeFalse();
    expect(dependencyInstallFor(patches)).toEqual({ force: false });
  });
});
