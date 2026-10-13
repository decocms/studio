import { useContext } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  assertSupportedEndpoint,
  type ContentClient,
  ContentProtocolError,
  createContentClient,
  type DescribeResult,
  PROTOCOL_NAME,
} from "@decocms/blocks/protocol";
import { useProjectContext } from "@/sdk";
import { buildSandboxUrl } from "@/sdk/sandbox-url";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { isWorkingTreeReadyPhase } from "@decocms/sandbox/shared";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import {
  TabDecoServeConnectionContext,
  useDecoServeConnection,
} from "@/hooks/use-deco-serve-connection";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { KEYS } from "@/lib/query-keys";
import {
  type ContentBackend,
  contentMode,
  contentProbesEnabled,
  type ProtocolBackend,
  readFailed,
  selectContentBackend,
} from "./content-backend";
import { useLastFoundV8, useMainSchemaV8 } from "@/hooks/use-main-schema-v8";
import {
  isMainSchemaChangedResponse,
  MainSchemaChangedError,
  mainSchemaHeaders,
  mainSchemaRead,
  resetMainSchemaAnswer,
} from "@/hooks/main-schema-changed";
import {
  classifyServeProbeError,
  NotDecoServeError,
  probeRetryDelay,
} from "./deco-serve-connection";
import { isSchemaAbsent } from "./schemaless";
import { isV8Schema } from "@decocms/shared/blocks-major";

export interface Probe {
  client: ContentClient;
  describe: DescribeResult;
  /** Whether the endpoint has a schema (see `isSchemaAbsent`). */
  hasSchema: boolean;
  /** Whether that schema declares `"blocksMajor": 8` (see `isV8Schema`). */
  v8Schema: boolean;
}

/** The sandbox answered 404 on `/_sandbox/rpc`: its daemon predates it. */
class NoSandboxProtocolError extends Error {}

/** Studio answered 409 `site_not_owned`: another project owns this site. */
class SiteNotOwnedError extends Error {}

/** The GitHub probe's answer for a v8 site this project doesn't own. */
export const GITHUB_SITE_NOT_OWNED = "site-not-owned" as const;

/** Whether a Studio response is the 409 `site_not_owned` answer. */
async function isSiteNotOwnedResponse(response: Response): Promise<boolean> {
  if (response.status !== 409) return false;
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { code?: unknown } | null;
  return body?.code === "site_not_owned";
}

/**
 * Probes Studio's GitHub backend (main plus the CDN draft; asked only once
 * main's schema is known to be v8): the probe when its schema is a v8 one,
 * null when it isn't (legacy), or {@link GITHUB_SITE_NOT_OWNED} when the
 * project doesn't own its site.
 */
export async function probeGithub(
  endpoint: string,
  doFetch: (request: Request) => Promise<Response> = (request) =>
    fetch(request),
  /**
   * Studio answered 409 `main_schema_changed` (main is no longer v8): called
   * before the call throws, so the editor re-reads main's answer.
   */
  onMainSchemaChanged?: () => void,
  /**
   * Main's schema as the page already read it (`mainSchemaRead`): this
   * route's `schema.get` reads main whatever the branch, so a v8 one is
   * reused and only `describe` is sent.
   */
  knownMainSchema?: unknown,
): Promise<Probe | null | typeof GITHUB_SITE_NOT_OWNED> {
  const client = createContentClient({
    endpoint,
    fetch: async (request) => {
      // This backend exists only for a v8 main: say so, so a main that
      // changed since is told apart from any other failure.
      const sent = new Request(request);
      for (const [name, value] of Object.entries(mainSchemaHeaders("v8"))) {
        sent.headers.set(name, value);
      }
      const response = await doFetch(sent);
      if (await isSiteNotOwnedResponse(response)) throw new SiteNotOwnedError();
      if (await isMainSchemaChangedResponse(response)) {
        onMainSchemaChanged?.();
        throw new MainSchemaChangedError();
      }
      return response;
    },
  });
  try {
    const result = await probe(
      client,
      isV8Schema(knownMainSchema) ? { schema: knownMainSchema } : undefined,
    );
    // Only a committed schema with `"blocksMajor": 8` is a v8 site; no
    // schema, or one without the field (a v7 `meta.gen.json`), is legacy.
    return result.v8Schema ? result : null;
  } catch (error) {
    if (error instanceof SiteNotOwnedError) return GITHUB_SITE_NOT_OWNED;
    throw error;
  }
}

/** How often a failed probe is retried, so a backend recovers on its own. */
const PROBE_RETRY_MS = 5_000;

/** The Studio GitHub backend's endpoint for one project and branch. */
function githubContentEndpoint(params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}): string {
  return new URL(
    `/api/${params.orgSlug}/decofile/${encodeURIComponent(params.virtualMcpId)}/${encodeURIComponent(params.branch)}/rpc`,
    window.location.origin,
  ).href;
}

/**
 * A sandbox daemon's content protocol, through Studio's sandbox proxy (the
 * same session auth and claim as the sandbox's other routes).
 */
function sandboxContentEndpoint(params: {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  threadId: string | null;
}): string {
  return new URL(buildSandboxUrl(params, "rpc"), window.location.origin).href;
}

/**
 * `describe` plus the schema, in one request. Throws `NotDecoServeError` when
 * something else answered (see `classifyServeProbeError`). With `known`, the
 * schema the caller already read for this endpoint, only `describe` is sent.
 */
export async function probe(
  client: ContentClient,
  known?: { schema: unknown },
): Promise<Probe> {
  const [described, schema] = await client.batch(
    known
      ? [{ method: "describe" }]
      : [{ method: "describe" }, { method: "schema.get" }],
  );
  if (!described?.ok) throw described?.error ?? new Error("no describe");
  const result = described.result as Partial<DescribeResult> | null;
  if (result?.protocol !== PROTOCOL_NAME) throw new NotDecoServeError();
  const describe = assertSupportedEndpoint(described.result as DescribeResult);
  if (known) {
    return {
      client,
      describe,
      hasSchema: known.schema != null,
      v8Schema: isV8Schema(known.schema),
    };
  }
  if (!schema) throw new Error("no schema.get");
  // `schema: null`, or NotFound from an older deco serve: no schema yet.
  if (isSchemaAbsent(schema)) {
    return { client, describe, hasSchema: false, v8Schema: false };
  }
  if (schema.ok) {
    const result = schema.result as { schema?: unknown } | null;
    return {
      client,
      describe,
      hasSchema: true,
      v8Schema: isV8Schema(result?.schema),
    };
  }
  throw schema.error;
}

/**
 * Probes a sandbox daemon's content protocol: the probe when its working
 * tree's schema is a v8 one, else null. As on GitHub, only a
 * `"blocksMajor": 8` schema is a v8 site. A daemon without the protocol (an
 * older image) answers 404: v7 (null), not an error to poll.
 */
export async function probeSandbox(
  endpoint: string,
  doFetch: (request: Request) => Promise<Response> = (request) =>
    fetch(request),
): Promise<Probe | null> {
  const client = createContentClient({
    endpoint,
    fetch: async (request) => {
      const response = await doFetch(request);
      if (response.status === 404) throw new NoSandboxProtocolError();
      return response;
    },
  });
  try {
    const result = await probe(client);
    return result.v8Schema ? result : null;
  } catch (error) {
    if (error instanceof NoSandboxProtocolError) return null;
    throw error;
  }
}

/**
 * The content backend of a project's editor (see `selectContentBackend`).
 * It is `pending` until the editor has a schema for its mode (Localhost: the
 * `deco serve`'s; Sandbox: the daemon's working tree; GitHub: main's, from
 * the server) and, for a v8 site, its content backend: callers hold their
 * reads until then, so it never reads from the v7 backend and then switches.
 * The project's `blocksMajor` marker is never a v8 answer here: it only
 * tells a failing daemon on a site last found v8 (waits) from any other one
 * (the v7 sandbox editor, as on main).
 */
export function useContentBackend(
  virtualMcpId: string | null | undefined,
  branch: string | null | undefined,
): ContentBackend {
  const { org } = useProjectContext();
  // Null on a v7 site: only Blocks v8 uses a `deco serve` (Localhost). On the
  // account-less `/site-editor` it is the page's own connection.
  const { connection, undecided: serveConnectionUndecided } =
    useDecoServeConnection(virtualMcpId);
  const { runtime } = useSessionRuntime(virtualMcpId);
  const tabConnection = useContext(TabDecoServeConnectionContext);
  // `isV8Schema` on main's schema, from the server (GitHub mode decides on it).
  const mainSchema = useMainSchemaV8(tabConnection ? null : virtualMcpId);
  // The server's last answer for main: only whether a daemon that never
  // answered is waited on (see `selectContentBackend`), never v8 itself.
  const markedV8 = useLastFoundV8(virtualMcpId);
  const mode = contentMode({ hasServeConnection: !!connection, runtime });
  const threadId = useOptionalChatTask()?.taskId ?? null;
  // The daemon answers once the working tree is there. Before its first
  // answer the editor waits (pending); once it answered for this thread, a
  // restart, hibernate or re-clone keeps that answer (see `sandboxSite`).
  const workingTreeReady = isWorkingTreeReadyPhase(
    useSandboxEvents().lifecycle.phase,
  );

  const queryClient = useQueryClient();
  const probes = contentProbesEnabled({
    mode,
    mainSchema,
    workingTreeReady,
  });
  const githubEnabled =
    probes.github && !!org.slug && !!virtualMcpId && !!branch;
  const github = useQuery({
    queryKey: KEYS.contentBackend(
      org.slug,
      virtualMcpId ?? "",
      branch ?? "",
      "github",
    ),
    queryFn: () =>
      probeGithub(
        githubContentEndpoint({
          orgSlug: org.slug,
          virtualMcpId: virtualMcpId!,
          branch: branch!,
        }),
        undefined,
        () => resetMainSchemaAnswer(queryClient, org.slug, virtualMcpId!),
        mainSchemaRead(queryClient, org.slug, virtualMcpId!)?.schema,
      ),
    enabled: githubEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    ...V8_PROBE_RETRY,
  });

  const sandboxEnabled =
    probes.sandbox && !!org.slug && !!virtualMcpId && !!branch;
  const sandbox = useQuery({
    queryKey: KEYS.contentBackend(
      org.slug,
      virtualMcpId ?? "",
      branch ?? "",
      "sandbox",
      threadId ?? "",
    ),
    queryFn: async (): Promise<Probe | null> => {
      return probeSandbox(
        sandboxContentEndpoint({
          orgSlug: org.slug,
          virtualMcpId: virtualMcpId!,
          branch: branch!,
          threadId,
        }),
      );
    },
    enabled: sandboxEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    ...V8_PROBE_RETRY,
  });

  // A connection exists only on a v8 site, once someone chose Localhost, or
  // on `/site-editor`; its own schema decides (`localServeBackend`).
  const localEnabled = !!connection;
  const local = useQuery({
    queryKey: KEYS.contentBackend(
      org.slug,
      virtualMcpId ?? "",
      "local",
      connection?.endpoint ?? "",
    ),
    queryFn: () =>
      probe(createContentClient({ endpoint: connection!.endpoint })),
    enabled: localEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    // Waits for `deco serve` to (re)start and reconnects on its own, backing
    // off up to 10s. A server that answers with an error (say, this origin
    // isn't allowed) is polled instead. A failed read or write resets this
    // probe (see content-protocol-api).
    retry: (_failures, error) =>
      !(error instanceof ContentProtocolError) &&
      !(error instanceof NotDecoServeError),
    retryDelay: (failures) => probeRetryDelay(failures + 1),
    // Also re-probed while there is no v8 schema, so `deco schema` is
    // picked up on its own.
    refetchInterval: (query) =>
      query.state.status === "error" || query.state.data?.v8Schema === false
        ? PROBE_RETRY_MS
        : false,
  });

  // Once connected, `describe` is re-read on every poll, so a stopped
  // `deco serve` is noticed without waiting for a failed read or write.
  const localKey = KEYS.contentBackend(
    org.slug,
    virtualMcpId ?? "",
    "local",
    connection?.endpoint ?? "",
  );
  const liveDescribe = useQuery({
    queryKey: KEYS.contentBackend(
      org.slug,
      virtualMcpId ?? "",
      "local-describe",
      connection?.endpoint ?? "",
    ),
    queryFn: async () => {
      try {
        return await local.data!.client.describe();
      } catch (error) {
        // It stopped answering: probe it again, so the Localhost row and
        // the editor say it's not running (and reconnect once it is back)
        // instead of keeping its last answer.
        void queryClient.invalidateQueries(
          { queryKey: localKey, exact: true },
          { cancelRefetch: false },
        );
        throw error;
      }
    },
    enabled: !!local.data && !tabConnection,
    refetchInterval: PROBE_RETRY_MS,
    retry: false,
  });
  const describe = liveDescribe.data ?? local.data?.describe;

  const decision = selectContentBackend({
    hasProject: !!virtualMcpId,
    hasServeConnection: !!connection,
    serveConnectionUndecided,
    runtime,
    mainSchema,
    githubSite:
      github.data === GITHUB_SITE_NOT_OWNED
        ? "not-owned"
        : github.data
          ? "v8"
          : github.data === null
            ? "v7"
            : readFailed(github)
              ? "error"
              : "loading",
    sandboxSite: sandboxSiteAnswer({
      data: sandbox.data,
      // The failure holds through a re-poll until a probe succeeds.
      isError: readFailed(sandbox),
      workingTreeReady,
    }),
    markedV8,
  });

  if (decision === "pending") return { kind: "pending" };
  // The schema that decides couldn't be read yet: undecided, retried.
  if (decision === "retrying-github") {
    return { kind: "pending", retrying: "github" };
  }
  if (decision === "retrying-sandbox") {
    return { kind: "pending", retrying: "sandbox" };
  }
  if (decision === "legacy") return { kind: "legacy" };
  if (decision === "protocol-github") {
    return toBackend("github", github.data as Probe, "");
  }
  // A v8 site another project owns: the editor guides (no retry).
  if (decision === "site-not-owned-github") {
    return { kind: "unavailable", source: "github", siteNotOwned: true };
  }
  if (decision === "protocol-sandbox") {
    return toBackend("sandbox", sandbox.data!, ":sandbox");
  }
  // Main is v8 and Studio's backend for it failed (a GitHub hiccup):
  // retried every PROBE_RETRY_MS, never the v7 editor in the meantime.
  if (decision === "unavailable-github") {
    return { kind: "unavailable", source: "github" };
  }
  return localServeBackend({
    probed: local.data,
    isError: local.isError,
    failureCount: local.failureCount,
    failure: local.error ?? local.failureReason,
    describe,
    endpoint: connection?.endpoint ?? "",
  });
}

/**
 * The sandbox daemon's answer for `selectContentBackend`. Once the daemon
 * answered for this thread (the probe's key is per thread and branch), that
 * answer holds while the working tree isn't ready: a restart, hibernate or
 * re-clone keeps a v7 site on the legacy editor and a v8 one on the protocol,
 * as on main. Before the first answer, a working tree that isn't there yet is
 * `unavailable` (the editor waits).
 */
export function sandboxSiteAnswer(input: {
  data: Probe | null | undefined;
  isError: boolean;
  workingTreeReady: boolean;
}): "v8" | "v7" | "loading" | "error" | "unavailable" {
  if (input.data !== undefined) return input.data ? "v8" : "v7";
  if (!input.workingTreeReady) return "unavailable";
  return input.isError ? "error" : "loading";
}

/**
 * Failed probes a connected `deco serve` rides out before the editor says
 * it's not running (about 7 s of backoff: a quick restart stays seamless).
 */
export const LOCAL_RECONNECT_GRACE_FAILURES = 3;

/**
 * The backend of a `deco serve` (Localhost) from its probe, whichever site
 * it serves (by the PO's decision, Studio doesn't check which). Its schema
 * must be a Blocks v8 one (`isV8Schema`): another schema is a problem the
 * editor explains (`not-v8`), and no schema yet is the schemaless guide. The
 * latest probe wins: once it fails, the editor and the Localhost row say it isn't
 * answering, and connect again once it answers.
 * Only a connected site rides out a short outage
 * (`LOCAL_RECONNECT_GRACE_FAILURES`).
 */
export function localServeBackend(input: {
  probed: Probe | undefined;
  isError: boolean;
  failureCount: number;
  failure: unknown;
  describe: DescribeResult | undefined;
  endpoint: string;
}): ContentBackend {
  if (input.probed?.hasSchema && !input.probed.v8Schema) {
    return {
      kind: "unavailable",
      source: "local",
      problem: { reason: "not-v8" },
    };
  }
  const settled = input.probed
    ? toBackend(
        "local",
        { ...input.probed, describe: input.describe ?? input.probed.describe },
        `:serve:${input.endpoint}`,
      )
    : null;
  const failing = input.isError || input.failureCount > 0;
  if (!failing) return settled ?? { kind: "pending" };
  if (
    settled?.kind === "protocol" &&
    !input.isError &&
    input.failureCount < LOCAL_RECONNECT_GRACE_FAILURES
  ) {
    return settled;
  }
  // Still retrying: `deco serve` is down, restarting or answering an error.
  return {
    kind: "unavailable",
    source: "local",
    problem: classifyServeProbeError(input.failure),
  };
}

/**
 * How the GitHub and sandbox probes retry. The editor waits on the answer,
 * so a failure is re-polled until it recovers; a site already known to be v8
 * keeps its data through a failed refetch.
 */
export const V8_PROBE_RETRY = {
  retry: 2,
  refetchInterval: (query: { state: { status: string } }) =>
    query.state.status === "error" ? PROBE_RETRY_MS : false,
};

function toBackend(
  source: ProtocolBackend["source"],
  probed: Probe,
  cacheKeySuffix: string,
): ProtocolBackend {
  return {
    kind: "protocol",
    source,
    client: probed.client,
    describe: probed.describe,
    cacheKeySuffix,
    hasSchema: probed.hasSchema,
  };
}
