/**
 * Where the site editor reads and writes a project's content.
 *
 * - `legacy`: the running site (`/live/_meta`, `/.decofile`), the sandbox
 *   working tree, or the Fast Preview decofile API — everything that existed
 *   before next-major Blocks.
 * - `protocol`: the Blocks content protocol, which needs only the committed
 *   schema and `.deco/blocks` and never runs the site's code. Served by a
 *   `deco serve` on the editor's machine (`local`), by Studio's GitHub backend
 *   (`github`), or by a sandbox's daemon over its working tree (`sandbox`).
 *
 * Pure: the selection and the poll merge are unit-tested without mocks.
 */

import type { ContentClient, DescribeResult } from "@decocms/blocks/protocol";
import { isLoopbackEndpoint, type ServeProblem } from "./deco-serve-connection";

export type ContentSource = "github" | "local" | "sandbox";

export interface ProtocolBackend {
  kind: "protocol";
  source: ContentSource;
  client: ContentClient;
  describe: DescribeResult;
  /** Distinguishes cache entries of different endpoints for one project. */
  cacheKeySuffix: string;
  /** Whether the endpoint has a schema (`deco schema` was run). */
  hasSchema?: boolean;
}

export type ContentBackend =
  /** Not decided yet: the flag or the probe is still loading. */
  | { kind: "pending" }
  | { kind: "legacy" }
  | ProtocolBackend
  /** A protocol endpoint that can't be reached right now. */
  | {
      kind: "unavailable";
      source: ContentSource;
      /** Why a `deco serve` can't be used (local only). */
      problem?: ServeProblem;
    };

/**
 * A content-protocol project, usable right now or not. The protocol never
 * runs site code: no in-place or gallery renders, no invoke-backed pickers,
 * no Run, no app install.
 */
export function isProtocolProject(backend: ContentBackend): boolean {
  return backend.kind === "protocol" || backend.kind === "unavailable";
}

/**
 * Whether the site editor shows the redesigned blocks editor. A v8 site (any
 * content-protocol project) always does; a v7 site follows the org's
 * `new_blocks_editor` flag. `undefined` while that can't be told yet, so the
 * editor waits instead of showing one editor and swapping to the other.
 *
 * `backend` is `null` outside a site (org settings, say): the flag alone.
 * `orgFlag` is `undefined` while the org settings load. With no org (the
 * account-less `/site-editor`) there is no flag to read: nothing opted in.
 */
export function newBlocksEditorEnabled(input: {
  backend: ContentBackend["kind"] | null;
  hasOrg: boolean;
  orgFlag: boolean | undefined;
}): boolean | undefined {
  const orgFlag = input.hasOrg ? input.orgFlag : false;
  const { backend } = input;
  if (backend === "protocol" || backend === "unavailable") return true;
  // Undecided: either generation gets the new editor when the flag is on.
  if (backend === "pending") return orgFlag === true ? true : undefined;
  return orgFlag;
}

/**
 * The app a connected `deco serve` previews (`describe.preview`, which
 * `deco serve --preview` sets): its URL when it is on this machine, else
 * `null`. Anywhere else would put an arbitrary page in the editor's frame.
 */
export function servePreviewUrl(backend: ContentBackend): string | null {
  if (backend.kind !== "protocol" || backend.source !== "local") return null;
  const url = backend.describe.preview?.url;
  return url && isLoopbackEndpoint(url) ? url : null;
}

/**
 * The Blocks major a v8 schema declares: `deco schema` writes a top-level
 * `"blocksMajor": 8` into `.deco/schema.gen.json` (`BLOCKS_MAJOR` in
 * `@decocms/blocks/protocol`, which `deco check` requires). Kept here rather
 * than imported because the pinned `@decocms/blocks` predates the constant.
 */
const V8_BLOCKS_MAJOR = 8;

/**
 * Whether a committed schema is a Blocks v8 one: only `blocksMajor === 8`
 * says so. The file name doesn't (v7 sites commit `meta.gen.json`, and either
 * name may lack the field); a missing field, any other value, or anything
 * that isn't a schema object is v7.
 */
export function isV8Schema(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    (schema as { blocksMajor?: unknown }).blocksMajor === V8_BLOCKS_MAJOR
  );
}

export type BackendDecision =
  | "pending"
  | "legacy"
  | "protocol-local"
  | "protocol-github"
  | "protocol-sandbox";

/**
 * Which backend a project's editor uses. Outside a project (forms with no
 * project id, such as SEO and the blog registry) there is no site to probe:
 * legacy. A connected `deco serve` wins, for every org: it exists only once
 * someone pasted its link into the "Local" draft option or opened the link it
 * printed, and only a Blocks v8 `deco serve` answers it. Then the legacy
 * Local tunnel. Behind the org flag, a Fast Preview (`cms`) session uses the
 * GitHub backend only when the branch's committed schema says
 * `"blocksMajor": 8` ({@link isV8Schema}). Everything else is v7 and legacy,
 * as before next-major Blocks — including a failed probe, which is retried in
 * the background (a site already known to be v8 keeps that answer). A sandbox
 * session, behind the same flag, uses its daemon's content protocol (the
 * working tree, saved like a `deco serve`'s) once the working tree is there
 * and its schema says `"blocksMajor": 8`; before that, and for v7, legacy.
 */
export function selectContentBackend(input: {
  /** Whether there is a project to probe (a virtual MCP id). */
  hasProject: boolean;
  /** The org flag (GitHub backend only); `undefined` while it loads. */
  flagEnabled: boolean | undefined;
  hasServeConnection: boolean;
  hasLocalTunnel: boolean;
  runtime: "cms" | "sandbox";
  /** The GitHub probe: is the branch's committed schema a v8 one? */
  githubSite: "v8" | "v7" | "loading" | "error";
  /**
   * The sandbox's daemon probe: is the working tree's schema a v8 one?
   * `unavailable` until the working tree is there (the sandbox is booting).
   */
  sandboxSite?: "v8" | "v7" | "loading" | "error" | "unavailable";
}): BackendDecision {
  if (!input.hasProject) return "legacy";
  if (input.hasServeConnection) return "protocol-local";
  if (input.hasLocalTunnel) return "legacy";
  if (input.runtime === "sandbox") {
    const site = input.sandboxSite ?? "unavailable";
    // Booting: today's sandbox UX, with no wait on the flag.
    // OPEN: a v8 site opened while its sandbox boots shows legacy until the
    // working tree lands, then switches (smallest option; no new wait state).
    if (site === "unavailable") return "legacy";
    if (input.flagEnabled === undefined) return "pending";
    if (!input.flagEnabled) return "legacy";
    if (site === "loading") return "pending";
    return site === "v8" ? "protocol-sandbox" : "legacy";
  }
  if (input.flagEnabled === undefined) return "pending";
  if (!input.flagEnabled) return "legacy";
  if (input.githubSite === "loading") return "pending";
  return input.githubSite === "v8" ? "protocol-github" : "legacy";
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
