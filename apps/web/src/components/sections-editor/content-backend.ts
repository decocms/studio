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
  /**
   * Not decided yet: the schema of the editor's mode is still being read.
   * `retrying` when that read failed and is retried (GitHub couldn't be
   * read, or the sandbox didn't answer): the site may be v7 or v8,
   * so it is neither the v8 `unavailable` state nor the v7 editor; the
   * editor waits with a "can't reach it, trying again" note.
   */
  | { kind: "pending"; retrying?: Exclude<ContentSource, "local"> }
  | { kind: "legacy" }
  | ProtocolBackend
  /** A protocol endpoint that can't be reached right now. */
  | {
      kind: "unavailable";
      source: ContentSource;
      /** Why a `deco serve` can't be used (local only). */
      problem?: ServeProblem;
      /**
       * GitHub only: a v8 site this project doesn't own (another project
       * created or imported it), so its content can't be edited from here.
       * Not retried: the editor guides instead.
       */
      siteNotOwned?: true;
    };

/**
 * A content-protocol project, usable right now or not. The protocol never
 * runs site code: no in-place or gallery renders, no invoke-backed pickers,
 * no Run, no app install.
 */
export function isProtocolProject(backend: ContentBackend): boolean {
  // `unavailable` is only ever a site already known to be v8 (a `pending`
  // read that failed stays `pending`, retrying).
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
    case "retrying-github":
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
 * Whether a session's draft lives on the hosted Deco CMS: GitHub mode on a
 * site whose main schema is a Blocks v8 one, with the editor on Studio's
 * GitHub backend (or still waiting for it). Nothing boots for such a session,
 * and its draft exists only once the first edit creates it. Never a v7 site,
 * never while main's answer is still loading (the preview holds a neutral
 * loader until then, `deciding`); never Localhost (a connected `deco serve`)
 * nor a sandbox, nor a v8 site this project doesn't own.
 */
export function hostedDraftSession(
  backend: ContentBackend,
  mode: ContentMode,
  mainSchema: SchemaAnswer,
): boolean {
  if (mode !== "github" || mainSchema !== "v8") return false;
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
  | "retrying-github"
  | "retrying-sandbox"
  | "site-not-owned-github";

/**
 * An answer of `isV8Schema` (`@decocms/shared/blocks-major`) on some schema:
 * main's (from the server), a sandbox working tree's, a branch's. `loading`
 * while it is read, `error` when it couldn't be (retried).
 */
export type SchemaAnswer = "v8" | "v7" | "loading" | "error";

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
 * Which backend a project's editor uses. The editor always waits for a
 * schema and the content of its mode, then reads the schema to decide v8 or
 * not (`isV8Schema`); it never shows the v7 path first and switches.
 *
 * - **Localhost** (a connected `deco serve`): `protocol-local`. Schema and
 *   content come from the `deco serve`, whose own schema decides
 *   (`localServeBackend`: a non-v8 one is a guided "not v8" state). A stored
 *   connection waits for main's answer (`serveConnectionUndecided`): only a
 *   v8 site uses one.
 * - **Sandbox** (the session has a sandbox): the sandbox's working tree
 *   decides (Studio reads it through the sandbox's file routes). Its schema v8
 *   → `protocol-sandbox` (content protocol); not v8 → `legacy` (the v7
 *   sandbox path). Waits (`pending`) until the working tree is there and
 *   answers.
 * - **GitHub** (otherwise): main's schema decides, read by the server
 *   (`mainSchema`). Not v8 → `legacy`: content from the branch, exactly as on
 *   main. v8 → `protocol-github`: content is main plus the CDN draft (the
 *   hosted CMS), once Studio's GitHub backend answers; a v8 site another
 *   project owns is `site-not-owned-github` (guided, not retried).
 *
 * A failed read of the schema that decides (main's, or the working tree's
 * before it ever answered) is `retrying-*` only on a project the server last found
 * v8 (its marker): still undecided, the editor waits and retries, and shows
 * neither editor. On any other project it is v7 (main's answer reads `v7`,
 * `useMainSchemaV8`; a failing working-tree read is `legacy`), so a site whose schema
 * can't be confirmed v8 gets the v7 editor as on main. Only
 * a site already known to be v8 whose content backend then fails is
 * `unavailable-*` (the v8 editor's retrying state).
 *
 * Outside a project (forms with no project id, such as SEO and the blog
 * registry) there is no site to read: legacy.
 */
export function selectContentBackend(input: {
  /** Whether there is a project to probe (a virtual MCP id). */
  hasProject: boolean;
  hasServeConnection: boolean;
  /** A connection is stored but main's answer isn't known yet. */
  serveConnectionUndecided?: boolean;
  runtime: "cms" | "sandbox";
  /** `isV8Schema` on main's schema, from the server (GitHub mode). */
  mainSchema: SchemaAnswer;
  /**
   * Studio's GitHub backend (main plus the CDN draft): does its schema say
   * v8? `not-owned` when the project doesn't own its site (Studio answers
   * 409 `site_not_owned`). Only asked once main is v8.
   */
  githubSite: SchemaAnswer | "not-owned";
  /**
   * The sandbox probe: is the working tree's schema a v8 one?
   * `unavailable` until the working tree is there (the sandbox is booting).
   */
  sandboxSite?: SchemaAnswer | "unavailable";
  /**
   * The project's `blocksMajor` marker (`isBlocksV8Project`): the server
   * last found main v8. A hint only, never a v8 answer: it decides just
   * whether a sandbox that failed before it ever answered is waited on
   * (marked) or treated as v7 (anything else, as on main).
   */
  markedV8?: boolean;
}): BackendDecision {
  if (!input.hasProject) return "legacy";
  const mode = contentMode(input);
  if (mode === "local") return "protocol-local";
  if (input.serveConnectionUndecided) return "pending";
  if (mode === "sandbox") {
    const site = input.sandboxSite;
    if (site === "v8") return "protocol-sandbox";
    if (site === "v7") return "legacy";
    // The sandbox never answered (a v8 answer is kept through a failed
    // refetch, so this is a site not known yet). Only a project the server
    // last found v8 (its marker) waits, undecided; any other one gets the v7
    // sandbox editor, as on main (which never waited on the sandbox), and a
    // v8 answer that arrives later takes over.
    if (site === "error") {
      return input.markedV8 ? "retrying-sandbox" : "legacy";
    }
    // Loading, or the sandbox's working tree isn't there yet.
    return "pending";
  }
  if (input.mainSchema === "loading") return "pending";
  if (input.mainSchema === "error") return "retrying-github";
  if (input.mainSchema === "v7") return "legacy";
  const site = input.githubSite;
  if (site === "v8") return "protocol-github";
  if (site === "not-owned") return "site-not-owned-github";
  // Main is v8: Studio's backend for it failed (retried).
  if (site === "error") return "unavailable-github";
  // main turned v7 between the two reads: main's answer is re-read on the
  // next open; the branch-backed v7 path meanwhile.
  if (site === "v7") return "legacy";
  return "pending";
}

/**
 * Which background probes `useContentBackend` runs: the sandbox's protocol in
 * Sandbox mode once its working tree is there (v7 and v8 alike: its schema
 * decides), Studio's GitHub backend in GitHub mode once main is known to be
 * v8. A v7 site in GitHub mode makes no probe: only main's (cached) schema
 * read. Localhost needs no probe here.
 */
export function contentProbesEnabled(input: {
  mode: ContentMode;
  mainSchema: SchemaAnswer;
  workingTreeReady: boolean;
}): { github: boolean; sandbox: boolean } {
  return {
    github: input.mode === "github" && input.mainSchema === "v8",
    sandbox: input.mode === "sandbox" && input.workingTreeReady,
  };
}

/**
 * Whether a retried read (a probe or main's schema) has failed and not yet
 * succeeded. A re-poll of a failed query with no data puts it back to
 * `pending` (`isError` false) while it runs: `errorUpdateCount` keeps the
 * failure, so an answer derived from it doesn't flip back to loading every
 * poll (which would swap the v7 fallback for the loader and back).
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
