import { describe, expect, test } from "bun:test";
import {
  classifyReleaseChanges,
  isVersionedManifest,
  parseChangedFiles,
  releaseManifestCandidates,
} from "./release-changes";

const API_MANIFEST = "apps/api/package.json";
const NATIVE_MANIFEST = "apps/native/package.json";

describe("release change classification", () => {
  test.each([
    {
      files: ["apps/api/src/index.ts"],
      manifests: [API_MANIFEST, NATIVE_MANIFEST],
      scope: "server",
    },
    {
      files: ["apps/web/src/main.tsx"],
      manifests: [API_MANIFEST, NATIVE_MANIFEST],
      scope: "web",
    },
    {
      files: ["apps/api/src/index.ts", "apps/web/src/main.tsx"],
      manifests: [API_MANIFEST, NATIVE_MANIFEST],
      scope: "both",
    },
    {
      files: ["apps/native/crates/local-api/src/lib.rs"],
      manifests: [API_MANIFEST, NATIVE_MANIFEST],
      scope: "both",
    },
    {
      files: ["packages/runtime/src/index.ts"],
      manifests: ["packages/runtime/package.json"],
      scope: "both",
    },
  ] as const)(
    "classifies $scope deploy changes",
    ({ files, manifests, scope }) => {
      expect(classifyReleaseChanges(files, new Set(manifests))).toMatchObject({
        deployScope: scope,
        packageManifests: manifests,
      });
    },
  );

  /** ONE release line: api, web and native changes all bump BOTH manifests,
   *  so the deployed server and the installed desktop app always answer
   *  "what version?" with the same number. A single-sided bump here is how
   *  the two lines would silently fork. */
  test("api, web and native changes each bump both manifests", () => {
    for (const file of [
      "apps/api/src/x.ts",
      "apps/web/src/x.tsx",
      "apps/native/src-tauri/tauri.conf.json5",
    ]) {
      expect(releaseManifestCandidates([file])).toEqual([
        API_MANIFEST,
        NATIVE_MANIFEST,
      ]);
    }
  });

  test("maps release inputs to sorted, deduplicated manifests", () => {
    const files = [
      "packages/ui/src/button.tsx",
      "apps/web/src/main.tsx",
      "apps/api/src/index.ts",
      "package.json",
      "scripts/build-studio.ts",
      "deploy/helm/studio/files/nginx.conf",
      "packages/runtime/src/index.ts",
      "packages/ui/src/input.tsx",
    ];

    expect(releaseManifestCandidates(files)).toEqual([
      API_MANIFEST,
      NATIVE_MANIFEST,
      "packages/runtime/package.json",
      "packages/ui/package.json",
    ]);
  });

  test("filters deleted and unversioned workspaces", () => {
    const files = [
      "packages/deleted/src/index.ts",
      "packages/private/src/index.ts",
      "packages/versioned/src/index.ts",
    ];

    expect(
      classifyReleaseChanges(
        files,
        new Set(["packages/versioned/package.json"]),
      ).packageManifests,
    ).toEqual(["packages/versioned/package.json"]);
  });

  test("recognizes only string package versions", () => {
    expect(isVersionedManifest({ version: "0.0.0" })).toBe(true);
    expect(isVersionedManifest({ version: 1 })).toBe(false);
    expect(isVersionedManifest({ private: true })).toBe(false);
    expect(isVersionedManifest(null)).toBe(false);
  });

  test("handles a #5120-sized file list", () => {
    const relevantFiles = [
      "apps/api/src/index.ts",
      "apps/web/src/main.tsx",
      "packages/bindings/src/index.ts",
      "packages/create-deco/index.ts",
      "packages/e2e/tests/smoke.spec.ts",
      "packages/harness/src/index.ts",
      "packages/mcp-utils/src/index.ts",
      "packages/runtime/src/index.ts",
      "packages/sandbox/src/index.ts",
      "packages/shared/src/index.ts",
      "packages/tunnel/src/index.ts",
      "packages/typegen/src/index.ts",
      "packages/ui/src/index.ts",
      "packages/mesh-sdk/src/index.ts",
      "packages/std/src/index.ts",
      "apps/mesh/src/index.ts",
    ];
    const fillerFiles = Array.from(
      { length: 2_823 - relevantFiles.length },
      (_, index) =>
        `docs/generated/${index.toString().padStart(4, "0")}-${"x".repeat(40)}.md`,
    );
    const serialized = `${[...relevantFiles, ...fillerFiles].join("\0")}\0`;
    const files = parseChangedFiles(serialized);
    const expectedManifests = [
      API_MANIFEST,
      "packages/bindings/package.json",
      "packages/create-deco/package.json",
      "packages/e2e/package.json",
      "packages/harness/package.json",
      "packages/mcp-utils/package.json",
      "packages/runtime/package.json",
      "packages/sandbox/package.json",
      "packages/shared/package.json",
      "packages/tunnel/package.json",
      "packages/typegen/package.json",
      "packages/ui/package.json",
    ];

    expect(Buffer.byteLength(serialized)).toBeGreaterThan(128 * 1024);
    expect(files).toHaveLength(2_823);
    expect(classifyReleaseChanges(files, new Set(expectedManifests))).toEqual({
      deployScope: "both",
      fileCount: 2_823,
      packageManifests: expectedManifests,
    });
  });
});
