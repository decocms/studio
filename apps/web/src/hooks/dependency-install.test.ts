import { describe, expect, it } from "bun:test";
import { findSiteApp, makeInstallAppPatches } from "@decocms/shared/site-apps";
import { dependencyInstallFor, needsDevRestart } from "./dependency-install";

const PACKAGE_JSON = `{
  "dependencies": {
    "@decocms/blocks": "^7.80.0"
  }
}
`;
const SETUP_TS = `import { autoconfigApps } from "@decocms/blocks-admin/apps";

const APP_REGISTRY = [];
`;
const MANIFEST_GEN = `import * as $$$$$$$$$$$0 from "./apps/site.ts";

const manifest = {
  "apps": {
    "site/apps/site.ts": $$$$$$$$$$$0,
  },
};

export default manifest;
`;

const deno = () =>
  makeInstallAppPatches({
    technology: "deno",
    entry: findSiteApp("deno", "deco-vtex")!,
    manifestGenTs: MANIFEST_GEN,
  });

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
    expect(dependencyInstallFor(deno())).toBeNull();
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

describe("needsDevRestart", () => {
  it("restarts on Deno, where no install step runs at all", () => {
    // The app's schema comes from its module: without a restart the runtime
    // never re-reads the manifest and the form stays empty.
    const patches = deno();
    expect(needsDevRestart(patches, dependencyInstallFor(patches))).toBeTrue();
  });

  it("leaves the restart to a forced install", () => {
    const patches = tanstack(PACKAGE_JSON);
    expect(needsDevRestart(patches, dependencyInstallFor(patches))).toBeFalse();
  });

  it("restarts when the install was sent unforced", () => {
    // It no-ops whenever the fingerprint matches, and `src/setup.ts` moved.
    const declared = tanstack(PACKAGE_JSON).files.find(
      (file) => file.path === "package.json",
    )!.content;
    const patches = tanstack(declared);
    expect(needsDevRestart(patches, dependencyInstallFor(patches))).toBeTrue();
  });

  it("leaves a healthy dev server alone when nothing was written", () => {
    expect(needsDevRestart({ ...deno(), files: [] }, null)).toBeFalse();
  });
});
