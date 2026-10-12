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
  contentProbesEnabled,
  type ProtocolBackend,
  selectContentBackend,
} from "./content-backend";
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
 * something else answered (see `classifyServeProbeError`).
 */
export async function probe(client: ContentClient): Promise<Probe> {
  const [described, schema] = await client.batch([
    { method: "describe" },
    { method: "schema.get" },
  ]);
  if (!described?.ok) throw described?.error ?? new Error("no describe");
  const result = described.result as Partial<DescribeResult> | null;
  if (result?.protocol !== PROTOCOL_NAME) throw new NotDecoServeError();
  const describe = assertSupportedEndpoint(described.result as DescribeResult);
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
 * A v7 project is `legacy` right away and runs no probe. A v8 project is
 * `pending` while the backend probe loads: callers hold their reads until
 * then, so it never reads from the v7 backend and then switches.
 */
export function useContentBackend(
  virtualMcpId: string | null | undefined,
  branch: string | null | undefined,
): ContentBackend {
  const { org } = useProjectContext();
  // Null on a v7 site: only Blocks v8 uses a `deco serve` (Localhost). On the
  // account-less `/site-editor` it is the page's own connection.
  const { connection } = useDecoServeConnection(virtualMcpId);
  // The server's cached `isV8Schema` answer for main (the project's marker).
  const { runtime, isBlocksV8: isV8Project } = useSessionRuntime(virtualMcpId);
  const tabConnection = useContext(TabDecoServeConnectionContext);
  const threadId = useOptionalChatTask()?.taskId ?? null;
  // The daemon answers once the working tree is there; before that the
  // sandbox is booting and the editor keeps today's (legacy) boot UX.
  const workingTreeReady = isWorkingTreeReadyPhase(
    useSandboxEvents().lifecycle.phase,
  );

  const probes = contentProbesEnabled({
    isV8Project,
    hasServeConnection: !!connection,
    runtime,
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
    queryFn: async (): Promise<Probe | null> => {
      const params = {
        orgSlug: org.slug,
        virtualMcpId: virtualMcpId!,
        branch: branch!,
      };
      const client = createContentClient({
        endpoint: githubContentEndpoint(params),
      });
      const result = await probe(client);
      // Only a committed schema with `"blocksMajor": 8` is a v8 site; no
      // schema, or one without the field (a v7 `meta.gen.json`), is legacy.
      return result.v8Schema ? result : null;
    },
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
  const queryClient = useQueryClient();
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
    isV8Project,
    hasServeConnection: !!connection,
    runtime,
    githubSite: github.data
      ? "v8"
      : github.data === null
        ? "v7"
        : github.isError
          ? "error"
          : "loading",
    sandboxSite: !workingTreeReady
      ? "unavailable"
      : sandbox.data
        ? "v8"
        : sandbox.data === null
          ? "v7"
          : sandbox.isError
            ? "error"
            : "loading",
  });

  if (decision === "pending") return { kind: "pending" };
  if (decision === "legacy") return { kind: "legacy" };
  if (decision === "protocol-github") {
    return toBackend("github", github.data!, "");
  }
  if (decision === "protocol-sandbox") {
    return toBackend("sandbox", sandbox.data!, ":sandbox");
  }
  // A v8 probe failed (a GitHub hiccup, the sandbox restarting): retried
  // every PROBE_RETRY_MS, never the v7 editor in the meantime.
  if (decision === "unavailable-github") {
    return { kind: "unavailable", source: "github" };
  }
  if (decision === "unavailable-sandbox") {
    return { kind: "unavailable", source: "sandbox" };
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
 * How the GitHub and sandbox probes retry (v8 projects only: v7 never
 * probes). The editor waits on the answer, so a failure is re-polled until it
 * recovers; a site already known to be v8 keeps its data through a failed
 * refetch.
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
