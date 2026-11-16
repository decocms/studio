/**
 * Where the site editor reads and writes a project's content.
 *
 * - `legacy`: the running site (`/live/_meta`, `/.decofile`), the sandbox
 *   working tree, or the Fast Preview decofile API — everything that existed
 *   before next-major Blocks.
 * - `protocol`: the Blocks content protocol, which needs only the committed
 *   schema and `.deco/blocks` and never runs the site's code. Served by a
 *   `deco serve` on the editor's machine (`local`), by Studio's GitHub backend
 *   (`github`), or by Studio over a sandbox's working tree (`sandbox`).
 *
 * Pure: the selection and the poll merge are unit-tested without mocks.
 */

import type { ContentClient, DescribeResult } from "@decocms/blocks/protocol";
import type { HostedRpc } from "@/cms/hosted-content";
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
  /** Studio's hosted backend: the hosted CMS site the draft lives on. */
  site?: string | null;
  /**
   * Studio's hosted backend: its draft endpoint for `cms.index` and
   * `cms.blocks`, which the editor reads in place of `blocks.list`.
   */
  hosted?: HostedRpc;
}

export type ContentBackend =
  /**
   * A v8 project's backend hasn't answered yet. `retrying` when the sandbox
   * failed before its first answer: the editor waits with a "can't reach
   * it, trying again" note.
   */
  | {
      kind: "pending";
      retrying?: "sandbox";
      source?: ContentSource;
      cacheKeySuffix?: string;
    }
  | { kind: "legacy" }
  | ProtocolBackend
  /** A protocol endpoint that can't be reached right now. */
  | {
      kind: "unavailable";
      source: ContentSource;
      /** Destination stays the same while an endpoint reconnects. */
      cacheKeySuffix?: string;
      /** Why a `deco serve` can't be used (local only). */
      problem?: ServeProblem;
      /**
       * GitHub only: a v8 site this project doesn't own (another project
       * created or imported it), so its content can't be edited from here.
       * Not retried: the editor guides instead.
       */
      siteNotOwned?: true;
    };

/** A storage destination is independent of its current connection status. */
export function contentBackendDestination(
  source: ContentSource,
  endpoint = "",
): Pick<ProtocolBackend, "source" | "cacheKeySuffix"> {
  return {
    source,
    cacheKeySuffix:
      source === "github"
        ? ""
        : source === "sandbox"
          ? ":sandbox"
          : `:serve:${endpoint}`,
  };
}

export type ContentBackendIdentity = Pick<ContentBackend, "kind"> &
  Partial<Pick<ProtocolBackend, "source" | "cacheKeySuffix">>;

/** Availability changes do not move an editor to a different destination. */
export function contentBackendScopeKey(
  backend: ContentBackendIdentity,
): string {
  return JSON.stringify([
    backend.kind === "legacy" ? "legacy" : "protocol",
    backend.source,
    backend.cacheKeySuffix,
  ]);
}

/**
 * A content-protocol project, usable right now or not. The protocol never
 * runs site code: no in-place or gallery renders, no invoke-backed pickers,
 * no Run, no app install.
 */
export function isProtocolProject(backend: ContentBackend): boolean {
  // `unavailable` is only ever a v8 project (its switch on).
  return backend.kind === "protocol" || backend.kind === "unavailable";
}

/**
 * The backend kind a decision maps to (`useContentBackend` builds the
 * backend itself). Pure, so the "no v7 flash" tests can check what the
 * editor shows at each step, not only the decision.
 */
export function decisionKind(
  decision: BackendDecision,
): ContentBackend["kind"] {
  switch (decision) {
    case "pending":
    case "retrying-sandbox":
      return "pending";
    case "legacy":
      return "legacy";
    case "protocol-local":
    case "protocol-github":
    case "protocol-sandbox":
      return "protocol";
    case "unavailable-github":
    case "site-not-owned-github":
      return "unavailable";
  }
}

/**
 * Whether the site editor shows the redesigned blocks editor. A v8 project
 * (a content-protocol backend, or one still connecting: only a v8 project is
 * ever `pending`) always does; a v7 project follows the org's
 * `new_blocks_editor` flag, `undefined` while the org settings load.
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
  if (backend === null || backend === "legacy") return orgFlag;
  return true;
}

/**
 * Whether a session's draft lives on the hosted Deco CMS: GitHub mode on a
 * Blocks v8 project (its switch on), with the editor on Studio's hosted
 * backend (or still waiting for it). Nothing boots for such a session, and
 * its draft exists only once the first edit creates it. Never a v7 project,
 * never Localhost (a connected `deco serve`) nor a sandbox, nor a v8 site
 * this project doesn't own.
 */
export function hostedDraftSession(
  backend: ContentBackend,
  mode: ContentMode,
  v8: boolean,
): boolean {
  if (mode !== "github" || !v8) return false;
  if (backend.kind === "pending") return true;
  if (backend.kind === "unavailable" && backend.siteNotOwned) return false;
  return (
    (backend.kind === "protocol" || backend.kind === "unavailable") &&
    backend.source === "github"
  );
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
 * Where an asset upload goes over the content protocol: the origin of a
 * connected `deco serve` that takes uploads (`describe.assets`) — Localhost and
 * the `/site-editor` play mode, the only places files land on a filesystem —
 * else `null`, and the field uploads to Studio's file storage (S3). A hosted
 * (`github`) or `sandbox` project never uploads to a filesystem, whatever its
 * `describe` says.
 */
export function serveAssetUploadOrigin(
  backend: ContentBackend,
  connection: { endpoint: string } | null | undefined,
): string | null {
  if (
    backend.kind !== "protocol" ||
    backend.source !== "local" ||
    !backend.describe.assets ||
    !connection
  ) {
    return null;
  }
  return new URL(connection.endpoint).origin;
}

export type BackendDecision =
  | "pending"
  | "legacy"
  | "protocol-local"
  | "protocol-github"
  | "protocol-sandbox"
  | "unavailable-github"
  | "retrying-sandbox"
  | "site-not-owned-github";

/**
 * A content backend's probe: `ready` once it answered (`describe` and its
 * schema), `loading` while it is read, `error` when it couldn't be (retried).
 */
export type ProbeAnswer = "ready" | "loading" | "error";

/** Where the editor's schema and content come from. */
export type ContentMode = "local" | "sandbox" | "github";

/**
 * The editor's mode: Localhost when a `deco serve` connection is chosen (or
 * on the account-less `/site-editor`), Sandbox when the session has a sandbox
 * (a coding session), else GitHub.
 */
export function contentMode(input: {
  hasServeConnection: boolean;
  runtime: "cms" | "sandbox";
}): ContentMode {
  if (input.hasServeConnection) return "local";
  return input.runtime === "sandbox" ? "sandbox" : "github";
}

/**
 * Which backend a project's editor uses. The project's "Blocks v8 site"
 * switch (`useBlocksV8Project`) decides v7 or v8 in every mode; no schema
 * does. It is known as soon as the project is, so the editor never shows one
 * generation first and switches.
 *
 * - **Switch off** (v7): `legacy` in every mode, exactly as on main: the
 *   branch (GitHub), the sandbox's v7 path (Sandbox), and Localhost is never
 *   offered (a stored `deco serve` connection reads as none).
 * - **Switch on** (v8), by mode:
 *   - **Localhost** (a connected `deco serve`): `protocol-local`
 *     (`localServeBackend` tells a stopped or foreign server apart).
 *   - **Sandbox** (the session has a sandbox): `protocol-sandbox` once
 *     Studio's protocol over the working tree answers; `pending` while the
 *     sandbox boots, `retrying-sandbox` while it fails before its first
 *     answer.
 *   - **GitHub** (otherwise): `protocol-github` once Studio's hosted backend
 *     (main plus the CDN draft) answers; `unavailable-github` while it
 *     fails, `site-not-owned-github` for a site another project owns (guided,
 *     not retried).
 *
 * Outside a project (forms with no project id, such as SEO and the blog
 * registry) there is no site: legacy. The account-less `/site-editor` has
 * no project switch: its own `deco serve` is all it edits (Localhost).
 */
export function selectContentBackend(input: {
  /** Whether there is a project to probe (a virtual MCP id). */
  hasProject: boolean;
  hasServeConnection: boolean;
  runtime: "cms" | "sandbox";
  /** The project's "Blocks v8 site" switch (`useBlocksV8Project`). */
  v8: boolean;
  /**
   * Studio's hosted backend (main plus the CDN draft). `not-owned` when the
   * project doesn't own its site (Studio answers 409 `site_not_owned`).
   * Only asked on a v8 project in GitHub mode.
   */
  githubSite: ProbeAnswer | "not-owned";
  /**
   * Studio's protocol over the sandbox's working tree. `unavailable` until
   * the working tree is there (the sandbox is booting). Only asked on a v8
   * project in Sandbox mode.
   */
  sandboxSite?: ProbeAnswer | "unavailable";
}): BackendDecision {
  if (!input.hasProject) return "legacy";
  const mode = contentMode(input);
  // A connection exists only on a v8 project (or on `/site-editor`).
  if (mode === "local") return "protocol-local";
  if (!input.v8) return "legacy";
  if (mode === "sandbox") {
    const site = input.sandboxSite;
    if (site === "ready") return "protocol-sandbox";
    // Failing before it ever answered (a later failure keeps its answer).
    if (site === "error") return "retrying-sandbox";
    // Loading, or the sandbox's working tree isn't there yet.
    return "pending";
  }
  const site = input.githubSite;
  if (site === "ready") return "protocol-github";
  if (site === "not-owned") return "site-not-owned-github";
  if (site === "error") return "unavailable-github";
  return "pending";
}

/**
 * Which background probes `useContentBackend` runs, only on a v8 project:
 * the sandbox's protocol in Sandbox mode once its working tree is there,
 * Studio's hosted backend in GitHub mode. A v7 project probes nothing (as on
 * main), and Localhost needs no probe here.
 */
export function contentProbesEnabled(input: {
  mode: ContentMode;
  v8: boolean;
  workingTreeReady: boolean;
}): { github: boolean; sandbox: boolean } {
  return {
    github: input.v8 && input.mode === "github",
    sandbox: input.v8 && input.mode === "sandbox" && input.workingTreeReady,
  };
}

/**
 * Whether a retried probe has failed and not yet succeeded. A re-poll of a
 * failed query with no data puts it back to `pending` (`isError` false)
 * while it runs: `errorUpdateCount` keeps the failure, so an answer derived
 * from it doesn't flip back to loading every poll.
 */
export function readFailed(query: {
  isError: boolean;
  errorUpdateCount: number;
}): boolean {
  return query.isError || query.errorUpdateCount > 0;
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
