/**
 * Which blog app this repo installs, and what its version allows in the CMS.
 *
 * The CMS writes `status`/`scheduledDatetime` into the decofile, but only the
 * blog app decides what to do with them — so a Studio that offers scheduling
 * against an app version that ignores it is offering a promise nothing keeps.
 * Every gate fails closed: an unreadable or non-semver ref reads as too old.
 *
 * Deno sites resolve `deco-cx/apps`; Node-family ones install
 * `@decocms/apps-blog`. Two distributions, two version lines, two thresholds.
 *
 * The committed manifests decide which one answers — not the project's
 * `metadata.runtime.selected`, which is a picker value an import may never
 * have written (`{"env": []}` is what a fresh one looks like).
 */
import type { PackageManager } from "@decocms/shared/runtime-defaults";
import type { CommittedRead } from "@/components/sections-editor/read-committed-file";
import type { PostStatus } from "./blog-data";

/** Apps version that introduced the post `status` filter. */
export const APPS_STATUS_VERSION = "0.161.0";

/** Apps version that introduced `scheduled` + `scheduledDatetime`. */
export const APPS_SCHEDULING_VERSION = "0.162.0";

/**
 * `@decocms/apps-blog` release that brought the publication gate to TanStack
 * sites. It knew neither `status` nor `scheduledDatetime` before, so this one
 * threshold answers for both.
 */
export const BLOG_PACKAGE_VERSION = "7.53.0";

/** The npm package carrying the blog app on a Node-family site. */
const BLOG_PACKAGE = "@decocms/apps-blog";

export type BlogSupport =
  /** No manifest answered yet — still reading, or the daemon is down. */
  | { kind: "unknown" }
  /** No blog app here: no `deco-cx/apps` pin, no {@link BLOG_PACKAGE}. */
  | { kind: "unsupported-runtime" }
  /** Installed, but the pin predates `status` (or can't be read). */
  | { kind: "outdated"; packageManager: PackageManager; version: string | null }
  /** `status` support, but no scheduling. Only Deno pins land here. */
  | { kind: "publish-only"; packageManager: PackageManager; version: string }
  /** Scheduling support. */
  | { kind: "full"; version: string };

/** `[major, minor, patch]`, or null when `value` isn't a plain semver. */
export function parseSemver(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a < b`, 0 when equal, positive when `a > b`. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    const diff = left[i]! - right[i]!;
    if (diff !== 0) return diff;
  }
  return 0;
}

/** An import-map value or schema ref pinning deco-apps to a released tag. */
const APPS_PIN = /deco-cx\/apps@v?(\d+\.\d+\.\d+)/;

/**
 * The deco-apps version the repo's `deno.json` pins. Every import value is
 * scanned rather than one well-known key, because sites name the import
 * differently (`apps/`, `deco/apps/`, …).
 */
export function appsVersionFromDenoJson(denoJson: unknown): string | null {
  const imports = (denoJson as { imports?: unknown } | null | undefined)
    ?.imports;
  if (!imports || typeof imports !== "object") return null;
  for (const value of Object.values(imports as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const version = APPS_PIN.exec(value)?.[1];
    if (version) return version;
  }
  return null;
}

/**
 * The deco-apps version the running site resolved, read from the schema refs
 * in `/live/_meta`. Every definition sourced from apps carries its jsdelivr
 * URL as the definition `title`, so the first one found answers for the site.
 */
export function appsVersionFromMeta(meta: unknown): string | null {
  const definitions = (
    meta as { schema?: { definitions?: unknown } } | null | undefined
  )?.schema?.definitions;
  if (!definitions || typeof definitions !== "object") return null;
  for (const definition of Object.values(
    definitions as Record<string, unknown>,
  )) {
    const title = (definition as { title?: unknown } | null)?.title;
    if (typeof title !== "string") continue;
    const version = APPS_PIN.exec(title)?.[1];
    if (version) return version;
  }
  return null;
}

/**
 * The range `package.json` declares for the blog app, or null when the site
 * doesn't install it. Raw, so callers can tell an absent dependency from one
 * pinned to something unreadable.
 */
export function blogPackageRange(packageJson: unknown): string | null {
  const pkg = packageJson as
    | { dependencies?: unknown; devDependencies?: unknown }
    | null
    | undefined;
  for (const field of [pkg?.dependencies, pkg?.devDependencies]) {
    if (!field || typeof field !== "object") continue;
    const range = (field as Record<string, unknown>)[BLOG_PACKAGE];
    if (typeof range === "string") return range;
  }
  return null;
}

/**
 * The lowest version a dependency range admits: an exact pin or a caret/tilde
 * range. Anything else (`latest`, `workspace:*`, a git URL) is null — too old,
 * because nothing in the file says otherwise.
 */
export function versionFromRange(range: string): string | null {
  const match = /^[\^~]?v?(\d+\.\d+\.\d+)$/.exec(range.trim());
  return match ? match[1]! : null;
}

/**
 * The package manager `package.json` declares in its `packageManager` field
 * (`"bun@1.3.5"`), for naming the update command. npm is the fallback: it is
 * the one every Node-family site can run.
 */
function packageManagerOf(packageJson: unknown): PackageManager {
  const field = (packageJson as { packageManager?: unknown } | null)
    ?.packageManager;
  const name = typeof field === "string" ? field.split("@")[0]?.trim() : null;
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

/** `[status, scheduling]` thresholds for the distribution this site installs. */
function thresholds(packageManager: PackageManager): [string, string] {
  return packageManager === "deno"
    ? [APPS_STATUS_VERSION, APPS_SCHEDULING_VERSION]
    : [BLOG_PACKAGE_VERSION, BLOG_PACKAGE_VERSION];
}

function classify(
  packageManager: PackageManager,
  version: string | null,
): BlogSupport {
  const [status, scheduling] = thresholds(packageManager);
  if (!version || compareSemver(version, status) < 0) {
    return { kind: "outdated", packageManager, version };
  }
  if (compareSemver(version, scheduling) < 0) {
    return { kind: "publish-only", packageManager, version };
  }
  return { kind: "full", version };
}

/**
 * Resolve what the blog CMS may offer, from the manifests the repo commits.
 * A committed `deno.json` (or a `meta` carrying apps refs) means the Deno
 * distribution; otherwise `package.json` answers. A read that failed is not a
 * repo without a blog app, so it resolves to `unknown` rather than accusing
 * the site of installing nothing.
 *
 * `deno.json` wins over `meta` because it is this branch's pin: right after a
 * `deno task update` the branch is already on the newer apps while a `meta`
 * served by production still reports the old one. `meta` is the fallback for
 * when the daemon can't answer (sandbox down, sandbox-less Fast Preview).
 */
export function blogSupport(input: {
  denoJson: CommittedRead<unknown>;
  packageJson: CommittedRead<unknown>;
  meta: unknown;
}): BlogSupport {
  const metaVersion = appsVersionFromMeta(input.meta);
  if (input.denoJson.kind === "data" || metaVersion) {
    const pinned =
      input.denoJson.kind === "data"
        ? appsVersionFromDenoJson(input.denoJson.data)
        : null;
    return classify("deno", pinned ?? metaVersion);
  }
  if (input.packageJson.kind === "data") {
    const range = blogPackageRange(input.packageJson.data);
    if (range === null) return { kind: "unsupported-runtime" };
    return classify(
      packageManagerOf(input.packageJson.data),
      versionFromRange(range),
    );
  }
  const unread =
    input.denoJson.kind === "unavailable" ||
    input.packageJson.kind === "unavailable";
  return unread ? { kind: "unknown" } : { kind: "unsupported-runtime" };
}

/**
 * The command that moves a site onto a newer blog app.
 *
 * The `@decocms/*` family pins itself exactly, so the whole scope moves
 * together or a second `@decocms/blocks` lands beside the first.
 */
export function blogUpdateCommand(packageManager: PackageManager): string {
  if (packageManager === "deno") return "deno task update";
  return `npx npm-check-updates -u "@decocms/*" && ${packageManager} install`;
}

/** Whether the editor may offer the published toggle. */
export function supportsPublishToggle(support: BlogSupport): boolean {
  return support.kind === "publish-only" || support.kind === "full";
}

/** Whether the editor and calendar may offer scheduling. */
export function supportsScheduling(support: BlogSupport): boolean {
  return support.kind === "full";
}

/** Why this site can't hold a post in `next`, or null when it can. */
export type StatusUnsupported =
  /** No manifest read yet, so no claim about this site can be made. */
  | { reason: "unknown" }
  /** The repo installs no blog app — no version bump fixes that. */
  | { reason: "no-app" }
  /** There is an app, and it has to reach `required`. */
  | {
      reason: "outdated";
      required: string;
      version: string | null;
      command: string;
    };

/**
 * Whether a post may be moved into `next` on this site.
 *
 * Only the live states are gated: they hand the post to the blog app, which
 * needs to know `status` to filter it and `scheduledDatetime` to hold it. Every
 * non-live state is stored as a block the site does not resolve at all, so it
 * works against any apps version — including pulling a post back OUT of a live
 * state on a site too old to have put it there.
 *
 * One predicate for the board and the editor both, so the two surfaces cannot
 * disagree about what is possible.
 */
export function postStatusUnsupported(
  support: BlogSupport,
  next: PostStatus,
): StatusUnsupported | null {
  if (support.kind === "full") return null;
  if (next !== "scheduled" && next !== "published") return null;
  if (next === "published" && supportsPublishToggle(support)) return null;
  if (support.kind === "unknown") return { reason: "unknown" };
  if (support.kind === "unsupported-runtime") return { reason: "no-app" };
  const [status, scheduling] = thresholds(support.packageManager);
  return {
    reason: "outdated",
    required: next === "scheduled" ? scheduling : status,
    version: support.version,
    command: blogUpdateCommand(support.packageManager),
  };
}
