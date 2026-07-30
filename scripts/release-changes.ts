import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const API_MANIFEST = "apps/api/package.json";
// The desktop app and the server share ONE release line: apps/api and
// apps/native carry the same version, always bumped together, so "what
// version are you on?" has a single answer whether the surface is the
// deployed web app or the installed binary. apps/web is embedded in both
// (served by the api image, baked into the desktop bundle), which is why a
// web change rolls the pair too. The native manifest's bump is what
// .github/workflows/release-native.yaml keys the DMG/zip release and the
// Homebrew cask off.
const NATIVE_MANIFEST = "apps/native/package.json";

export type DeployScope = "both" | "server" | "web" | "none";

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

  const addReleaseLine = () => {
    // ONE release line — apps/api and apps/native move together, always.
    // Adding one without the other is how the deployed server and the
    // installed desktop app end up answering "what version?" differently,
    // permanently (each manifest bumps from its own current value, so a
    // single-sided bump is an offset forever).
    manifests.add(API_MANIFEST);
    manifests.add(NATIVE_MANIFEST);
  };

  for (const file of files) {
    if (file === "package.json" || file === "scripts/build-studio.ts") {
      addReleaseLine();
      continue;
    }

    if (
      file.startsWith("apps/api/") ||
      file.startsWith("apps/web/") ||
      file.startsWith("apps/native/")
    ) {
      addReleaseLine();
      continue;
    }

    // The nginx config is baked into the web image tagged with the API version.
    if (file.startsWith("deploy/helm/studio/files/")) {
      addReleaseLine();
      continue;
    }

    const packageMatch = /^packages\/([^/]+)\//.exec(file);
    const packageDirectory = packageMatch?.[1];
    if (packageDirectory) {
      manifests.add(`packages/${packageDirectory}/package.json`);
    }
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
  // A merge that touches ONLY the desktop app bumps the shared release line
  // (the version must stay single) but changes nothing any pod runs — "none"
  // tells the CD dispatch to skip the fleet. A consumer that predates the
  // value treats it like the old fallthrough ("both"), so this can only
  // reduce churn, never lose a rollout.
  const nativeOnly =
    files.length > 0 && files.every((file) => file.startsWith("apps/native/"));
  const deployScope = nativeOnly
    ? "none"
    : hasApiChanges && !hasWebChanges
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
