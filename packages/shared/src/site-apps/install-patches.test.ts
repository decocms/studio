import { describe, expect, it } from "bun:test";
import { findSiteApp } from "./index";
import { makeInstallAppPatches, SiteAppInstallError } from "./install-patches";
import type { SiteAppRegistryEntry } from "./types";

const vtexDeno = findSiteApp("deno", "deco-vtex")!;
const blogTanstack = findSiteApp("tanstack", "deco-blog")!;

const PACKAGE_JSON = `{
  "name": "storefront-tanstack",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev"
  },
  "dependencies": {
    "@decocms/apps-shopify": "^7.77.1",
    "@decocms/blocks": "^7.77.1",
    "@tanstack/react-router": "^1.0.0",
    "react": "^19.0.0"
  },
  "devDependencies": {
    "typescript": "^5.9.0"
  }
}
`;

const SETUP_TS = `import "./cache-config";

import { createSiteSetup } from "@decocms/blocks/setup";
import { autoconfigApps, type AppRegistry } from "@decocms/blocks-admin/apps";
import { SHOPIFY_REGISTRY_ENTRY } from "@decocms/apps-shopify/registry";
import * as shopifyMod from "@decocms/apps-shopify/mod";
import { blocks as generatedBlocks } from "../.deco/blocks.gen";

const APP_REGISTRY: AppRegistry = [
  { ...SHOPIFY_REGISTRY_ENTRY, module: async () => shopifyMod as never },
];

createSiteSetup({ blocks: generatedBlocks });

await autoconfigApps(generatedBlocks, APP_REGISTRY);
`;

const tanstackInput = (
  overrides?: Partial<Parameters<typeof makeInstallAppPatches>[0]>,
) => ({
  technology: "tanstack" as const,
  entry: blogTanstack,
  decocmsVersion: "^7.77.1",
  packageJson: PACKAGE_JSON,
  setupTs: SETUP_TS,
  ...overrides,
});

const fileAt = (
  patches: ReturnType<typeof makeInstallAppPatches>,
  path: string,
) => patches.files.find((file) => file.path === path);

describe("makeInstallAppPatches — deno", () => {
  it("writes the app re-export and the block, and adds no dependency", () => {
    const patches = makeInstallAppPatches({
      technology: "deno",
      entry: vtexDeno,
    });

    expect(patches.files).toEqual([
      {
        path: "apps/deco/vtex.ts",
        content:
          'export { default } from "apps/vtex/mod.ts";\nexport * from "apps/vtex/mod.ts";\n',
      },
    ]);
    expect(patches.block).toEqual({
      key: "deco-vtex",
      value: { __resolveType: "site/apps/deco/vtex.ts" },
    });
  });
});

describe("makeInstallAppPatches — tanstack", () => {
  it("writes the re-export, the dependency, the registry entry and the block", () => {
    const patches = makeInstallAppPatches(tanstackInput());

    expect(patches.files.map((file) => file.path).sort()).toEqual([
      "package.json",
      "src/apps/blog.ts",
      "src/setup.ts",
    ]);
    expect(patches.block).toEqual({
      key: "deco-blog",
      value: { __resolveType: "site/apps/deco/blog.ts" },
    });
    expect(fileAt(patches, "src/apps/blog.ts")!.content).toBe(
      'export * from "@decocms/apps-blog/mod";\n',
    );
  });

  it("inserts the dependency alphabetically and leaves every other byte alone", () => {
    const patches = makeInstallAppPatches(tanstackInput());

    expect(fileAt(patches, "package.json")!.content).toBe(
      PACKAGE_JSON.replace(
        '    "@decocms/apps-shopify": "^7.77.1",\n',
        '    "@decocms/apps-blog": "^7.77.1",\n    "@decocms/apps-shopify": "^7.77.1",\n',
      ),
    );
  });

  it("appends a dependency that sorts last, re-commaing the previous entry", () => {
    const content = fileAt(
      makeInstallAppPatches(
        tanstackInput({
          packageJson: `{
  "dependencies": {
    "@decocms/apps-algolia": "^7.77.1"
  }
}
`,
        }),
      ),
      "package.json",
    )!.content;

    expect(content).toBe(`{
  "dependencies": {
    "@decocms/apps-algolia": "^7.77.1",
    "@decocms/apps-blog": "^7.77.1"
  }
}
`);
  });

  it("adds both imports and the registry entry to setup.ts", () => {
    const content = fileAt(
      makeInstallAppPatches(tanstackInput()),
      "src/setup.ts",
    )!.content;

    expect(content).toBe(`import "./cache-config";

import { createSiteSetup } from "@decocms/blocks/setup";
import { autoconfigApps, type AppRegistry } from "@decocms/blocks-admin/apps";
import { SHOPIFY_REGISTRY_ENTRY } from "@decocms/apps-shopify/registry";
import * as shopifyMod from "@decocms/apps-shopify/mod";
import { blocks as generatedBlocks } from "../.deco/blocks.gen";
import { BLOG_REGISTRY_ENTRY } from "@decocms/apps-blog/registry";
import * as blogMod from "@decocms/apps-blog/mod";

const APP_REGISTRY: AppRegistry = [
  { ...BLOG_REGISTRY_ENTRY, module: async () => blogMod as never },
  { ...SHOPIFY_REGISTRY_ENTRY, module: async () => shopifyMod as never },
];

createSiteSetup({ blocks: generatedBlocks });

await autoconfigApps(generatedBlocks, APP_REGISTRY);
`);
  });

  it("fills an empty APP_REGISTRY", () => {
    const content = fileAt(
      makeInstallAppPatches(
        tanstackInput({
          setupTs:
            'import { autoconfigApps } from "@decocms/blocks-admin/apps";\n\nconst APP_REGISTRY = [];\n',
        }),
      ),
      "src/setup.ts",
    )!.content;

    expect(
      content,
    ).toBe(`import { autoconfigApps } from "@decocms/blocks-admin/apps";
import { BLOG_REGISTRY_ENTRY } from "@decocms/apps-blog/registry";
import * as blogMod from "@decocms/apps-blog/mod";

const APP_REGISTRY = [
  { ...BLOG_REGISTRY_ENTRY, module: async () => blogMod as never },
];
`);
  });

  it("is idempotent — a second install of the same app patches nothing but the block", () => {
    const first = makeInstallAppPatches(tanstackInput());
    const second = makeInstallAppPatches(
      tanstackInput({
        packageJson: fileAt(first, "package.json")!.content,
        setupTs: fileAt(first, "src/setup.ts")!.content,
      }),
    );

    expect(second.files.map((file) => file.path)).toEqual(["src/apps/blog.ts"]);
    expect(second.block).toEqual(first.block);
  });

  it("refuses the legacy wiring, naming the real blocker", () => {
    // Shape captured from a real branch: imported, so there is no array to add to.
    const legacy = `import { autoconfigApps } from "@decocms/start/apps/autoconfig";
import { APP_REGISTRY } from "@decocms/apps/registry";

autoconfigApps(generatedBlocks, APP_REGISTRY);
`;
    expect(() =>
      makeInstallAppPatches(tanstackInput({ setupTs: legacy })),
    ).toThrow(/monolithic `@decocms\/apps` registry/);
  });

  it("refuses a setup.ts with no APP_REGISTRY", () => {
    expect(() =>
      makeInstallAppPatches(
        tanstackInput({ setupTs: 'import "./cache-config";\n' }),
      ),
    ).toThrow(SiteAppInstallError);
  });

  it("refuses a package.json with no dependencies object", () => {
    expect(() =>
      makeInstallAppPatches(
        tanstackInput({ packageJson: '{\n  "name": "site"\n}\n' }),
      ),
    ).toThrow(/no "dependencies"/);
  });

  it("refuses a repository that declares no @decocms package", () => {
    expect(() =>
      makeInstallAppPatches(tanstackInput({ decocmsVersion: null })),
    ).toThrow(/not a TanStack deco site/);
  });

  it("refuses an app with no TanStack package", () => {
    const denoOnly: SiteAppRegistryEntry = { ...vtexDeno, npm: undefined };
    expect(() =>
      makeInstallAppPatches(tanstackInput({ entry: denoOnly })),
    ).toThrow(/only available on Deno sites/);
  });
});
