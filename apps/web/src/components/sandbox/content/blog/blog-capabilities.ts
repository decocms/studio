/**
 * What the site's runtime and pinned deco-apps version allow in the blog CMS.
 *
 * The CMS writes `status`/`scheduledDatetime` into the decofile, but only the
 * blog app decides what to do with them — so a Studio that offers scheduling
 * against an app version that ignores it is offering a promise nothing keeps.
 * Every gate fails closed: an unreadable or non-semver ref reads as too old.
 */
import type { PostStatus } from "./blog-data";

/** Apps version that introduced the post `status` filter. */
export const APPS_STATUS_VERSION = "0.161.0";

/** Apps version that introduced `scheduled` + `scheduledDatetime`. */
export const APPS_SCHEDULING_VERSION = "0.162.0";

/** The command that moves a site onto a newer apps pin. */
export const APPS_UPDATE_COMMAND = "deno task update";

export type BlogSupport =
  /** Not a Deno site — the deco blog app doesn't run here at all. */
  | { kind: "unsupported-runtime" }
  /** Deno, but the pin predates `status` (or can't be read). */
  | { kind: "outdated"; version: string | null }
  /** Deno with `status` support, but no scheduling. */
  | { kind: "publish-only"; version: string }
  /** Deno with scheduling support. */
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
 * Resolve what the blog CMS may offer. `packageManager` is the detected
 * runtime (`metadata.runtime.selected`); anything but `deno` means the deco
 * blog app isn't what renders this site.
 *
 * `deno.json` wins over `meta` because it is this branch's pin: right after a
 * `deno task update` the branch is already on the newer apps while a `meta`
 * served by production still reports the old one. `meta` is the fallback for
 * when the daemon can't answer (sandbox down, sandbox-less Fast Preview).
 */
export function blogSupport(input: {
  packageManager: string | null | undefined;
  denoJson: unknown;
  meta: unknown;
}): BlogSupport {
  if (input.packageManager !== "deno") return { kind: "unsupported-runtime" };
  const version =
    appsVersionFromDenoJson(input.denoJson) ?? appsVersionFromMeta(input.meta);
  if (!version || compareSemver(version, APPS_STATUS_VERSION) < 0) {
    return { kind: "outdated", version };
  }
  if (compareSemver(version, APPS_SCHEDULING_VERSION) < 0) {
    return { kind: "publish-only", version };
  }
  return { kind: "full", version };
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
export interface StatusUnsupported {
  /** Apps version the target needs. */
  required: string;
  /** Version this site is on, or null when unreadable / not a Deno site. */
  version: string | null;
}

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
  const version =
    support.kind === "unsupported-runtime" ? null : support.version;
  if (next === "scheduled" && !supportsScheduling(support)) {
    return { required: APPS_SCHEDULING_VERSION, version };
  }
  if (next === "published" && !supportsPublishToggle(support)) {
    return { required: APPS_STATUS_VERSION, version };
  }
  return null;
}
