import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// apps/web ships inside the api image, so it shares the api version.
const API_MANIFEST = "apps/api/package.json";
// Tags the sandbox image and, via release-tagging.yaml's CHART_IMAGE_LOCKSTEP,
// the sandbox-env chart's image.tag.
const SANDBOX_MANIFEST = "packages/sandbox/package.json";
// @decocms/sandbox-controller bundles these sources and publishes on a version
// its registry does not have yet (publish-sandbox-controller-npm.yaml, whose
// trigger paths list the same directories).
const SANDBOX_CONTROLLER_MANIFEST = "packages/sandbox-controller/package.json";
const SANDBOX_CONTROLLER_SOURCES = [
  "packages/sandbox/server/",
  "packages/shared/src/git-providers/",
  "packages/shared/src/std/",
];

export type DeployScope = "both" | "server" | "web";

export interface ReleaseChanges {
  deployScope: DeployScope;
  fileCount: number;
  packageManifests: string[];
}

export function parseChangedFiles(contents: string): string[] {
  const separator = contents.includes("\0") ? "\0" : "\n";
  return contents
    .split(separator)
    .map((file) => (separator === "\n" ? file.replace(/\r$/, "") : file))
    .filter(Boolean);
}

export function releaseManifestCandidates(files: readonly string[]): string[] {
  const manifests = new Set<string>();

  for (const file of files) {
    if (file === "package.json" || file === "scripts/build-studio.ts") {
      manifests.add(API_MANIFEST);
      continue;
    }

    if (file.startsWith("apps/api/") || file.startsWith("apps/web/")) {
      manifests.add(API_MANIFEST);
      continue;
    }

    // The nginx config is baked into the web image tagged with the API version.
    if (file.startsWith("deploy/helm/studio/files/")) {
      manifests.add(API_MANIFEST);
      continue;
    }

    // The harness runner is packed INTO the sandbox image
    // (packages/sandbox/image/Dockerfile), and that image is tagged from
    // packages/sandbox/package.json. Without this the version stays put, the
    // rebuild overwrites the live tag in place, and every node that already
    // cached it keeps serving the old runner — #6816's fix reached 4 of 21
    // prod sandbox pods that way.
    if (file.startsWith("packages/harness-runner/")) {
      manifests.add(SANDBOX_MANIFEST);
    }

    if (SANDBOX_CONTROLLER_SOURCES.some((dir) => file.startsWith(dir))) {
      manifests.add(SANDBOX_CONTROLLER_MANIFEST);
    }

    const packageMatch = /^packages\/([^/]+)\//.exec(file);
    const packageDirectory = packageMatch?.[1];
    if (packageDirectory) {
      manifests.add(`packages/${packageDirectory}/package.json`);
    }
  }

  // The controller's default Freestyle image is tagged from the sandbox
  // version it bundles, so a new image only reaches it through a new release.
  if (manifests.has(SANDBOX_MANIFEST)) {
    manifests.add(SANDBOX_CONTROLLER_MANIFEST);
  }

  return [...manifests].sort();
}

export function isVersionedManifest(manifest: unknown): boolean {
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    "version" in manifest &&
    typeof manifest.version === "string"
  );
}

export function classifyReleaseChanges(
  files: readonly string[],
  versionedManifests: ReadonlySet<string>,
): ReleaseChanges {
  const hasApiChanges = files.some((file) => file.startsWith("apps/api/"));
  const hasWebChanges = files.some((file) => file.startsWith("apps/web/"));
  const deployScope =
    hasApiChanges && !hasWebChanges
      ? "server"
      : hasWebChanges && !hasApiChanges
        ? "web"
        : "both";

  return {
    deployScope,
    fileCount: files.length,
    packageManifests: releaseManifestCandidates(files).filter((manifest) =>
      versionedManifests.has(manifest),
    ),
  };
}

async function findVersionedManifests(
  candidates: readonly string[],
  repositoryRoot: string,
): Promise<Set<string>> {
  const versionedManifests = new Set<string>();

  for (const manifestPath of candidates) {
    let source: string;
    try {
      source = await readFile(join(repositoryRoot, manifestPath), "utf8");
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }

    if (isVersionedManifest(JSON.parse(source))) {
      versionedManifests.add(manifestPath);
    }
  }

  return versionedManifests;
}

async function main(): Promise<void> {
  const changedFilesPath = Bun.argv[2];
  if (!changedFilesPath) {
    throw new Error("Usage: bun scripts/release-changes.ts <changed-files>");
  }

  const files = parseChangedFiles(await readFile(changedFilesPath, "utf8"));
  const repositoryRoot = resolve(import.meta.dir, "..");
  const candidates = releaseManifestCandidates(files);
  const versionedManifests = await findVersionedManifests(
    candidates,
    repositoryRoot,
  );

  process.stdout.write(
    JSON.stringify(classifyReleaseChanges(files, versionedManifests)),
  );
}

if (import.meta.main) {
  await main();
}
