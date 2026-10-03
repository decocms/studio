/**
 * Where the site editor reads and writes a project's content.
 *
 * - `legacy`: the running site (`/live/_meta`, `/.decofile`), the sandbox
 *   working tree, or the Fast Preview decofile API — everything that existed
 *   before next-major Blocks.
 * - `protocol`: the Blocks content protocol, which needs only the committed
 *   schema and `.deco/blocks` and never runs the site's code. Served either by
 *   a `deco serve` on the editor's machine (`local`) or by Studio's GitHub
 *   backend (`github`).
 *
 * Pure: the selection and the poll merge are unit-tested without mocks.
 */

import type {
  ContentClient,
  DescribeResult,
  SchemaGetResult,
} from "@decocms/shared/blocks-protocol";

export type ContentSource = "github" | "local";

export interface ProtocolBackend {
  kind: "protocol";
  source: ContentSource;
  client: ContentClient;
  describe: DescribeResult;
  /** The first `schema.get`, read while probing, so the editor needn't read it twice. */
  schema: Extract<SchemaGetResult, { notModified: false }> | null;
  /** Distinguishes cache entries of different endpoints for one project. */
  cacheKeySuffix: string;
}

export type ContentBackend =
  /** Not decided yet: the flag or the probe is still loading. */
  | { kind: "pending" }
  | { kind: "legacy" }
  | ProtocolBackend
  /** A connected `deco serve` that can't be used right now. */
  | {
      kind: "unavailable";
      source: "local";
      reason: "unauthorized" | "unreachable";
    };

/** What the editor may do on a backend; the protocol never runs site code. */
export interface ContentCapabilities {
  /** Re-render the preview in place through `/live/previews`. */
  inPlaceRender: boolean;
  /** Gallery thumbnails and block previews rendered by the site. */
  livePreviews: boolean;
  /** Pickers whose options come from running a loader. */
  invoke: boolean;
  /** The Run button and runnable (saved loader/action) blocks. */
  runBlocks: boolean;
  /** Installing commerce apps from the editor. */
  installApps: boolean;
  /** Encrypting v7 secrets through the site's encrypt action. */
  v7Secrets: boolean;
}

export function contentCapabilities(
  backend: ContentBackend,
): ContentCapabilities {
  // A connected `deco serve` that's down is still a protocol project.
  const legacy = backend.kind === "legacy" || backend.kind === "pending";
  return {
    inPlaceRender: legacy,
    livePreviews: legacy,
    invoke: legacy,
    runBlocks: legacy,
    installApps: legacy,
    v7Secrets: legacy,
  };
}

export type BackendDecision =
  | "pending"
  | "legacy"
  | "protocol-local"
  | "protocol-github";

/**
 * Which backend a project's editor uses. A connected `deco serve` wins, then
 * the legacy Local tunnel; a Fast Preview (`cms`) session uses the GitHub
 * backend when the branch has a committed schema. Sandbox sessions stay
 * legacy: their pod's working tree shares the branch, and commits from here
 * would make the two diverge.
 */
export function selectContentBackend(input: {
  /** The org flag; `undefined` while the org settings load. */
  flagEnabled: boolean | undefined;
  hasServeConnection: boolean;
  hasLocalTunnel: boolean;
  runtime: "cms" | "sandbox";
  /** The GitHub probe: does the branch have a committed schema? */
  githubSchema: "present" | "absent" | "loading";
}): BackendDecision {
  if (input.flagEnabled === undefined) return "pending";
  if (!input.flagEnabled) return "legacy";
  if (input.hasServeConnection) return "protocol-local";
  if (input.hasLocalTunnel || input.runtime !== "cms") return "legacy";
  if (input.githubSchema === "loading") return "pending";
  return input.githubSchema === "present" ? "protocol-github" : "legacy";
}

/**
 * Applies a polled block map over the local copy: the remote map wins, except
 * for entries the editor is still saving, which keep their local value (or
 * stay deleted) until their own write lands.
 */
export function mergePolledBlocks(
  remote: Record<string, unknown>,
  local: Record<string, unknown> | undefined,
  saving: ReadonlySet<string>,
): Record<string, unknown> {
  if (!local || saving.size === 0) return remote;
  const next = { ...remote };
  for (const key of saving) {
    if (Object.hasOwn(local, key)) next[key] = local[key];
    else delete next[key];
  }
  return next;
}

/**
 * The block names an in-flight decofile write touches, from the variables of
 * the write mutations (`{ blockKey }` or `{ writes, deletes }`).
 */
export function blockKeysOfWrite(variables: unknown): string[] {
  if (!variables || typeof variables !== "object") return [];
  const v = variables as Record<string, unknown>;
  const keys: string[] = [];
  if (typeof v.blockKey === "string") keys.push(v.blockKey);
  if (v.writes && typeof v.writes === "object") {
    keys.push(...Object.keys(v.writes));
  }
  if (Array.isArray(v.deletes)) {
    keys.push(...v.deletes.filter((k): k is string => typeof k === "string"));
  }
  return keys;
}
