import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const API_MANIFEST = "apps/api/package.json";
// The desktop app embeds apps/web (tauri.conf's beforeBuildCommand builds it
// into the bundle), so a web release IS a native release: any change that
// rolls the web frontend must also roll the binary that ships it. The bumped
// version is what .github/workflows/release-desktop.yaml keys the DMG/zip
// release and the Homebrew cask off.
const NATIVE_MANIFEST = "apps/native/package.json";

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
      // apps/web is embedded in the desktop bundle — a web change rolls the
      // binary too. Deliberately no `continue`-style exclusivity: one file
      // can roll both the server image and the desktop app.
      if (file.startsWith("apps/web/")) {
        manifests.add(NATIVE_MANIFEST);
      }
      continue;
    }

    if (file.startsWith("apps/native/")) {
      manifests.add(NATIVE_MANIFEST);
      continue;
    }

    // The nginx config is baked into the web image tagged with the API version.
    if (file.startsWith("deploy/helm/studio/files/")) {
      manifests.add(API_MANIFEST);
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
