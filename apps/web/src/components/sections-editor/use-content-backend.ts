import { useQuery } from "@tanstack/react-query";
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
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useOrgFlagState } from "@/hooks/use-organization-settings";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { KEYS } from "@/lib/query-keys";
import {
  type ContentBackend,
  isV8Schema,
  type ProtocolBackend,
  selectContentBackend,
} from "./content-backend";
import {
  classifyServeProbeError,
  NotDecoServeError,
  probeRetryDelay,
} from "./deco-serve-connection";
import { isSchemaAbsent } from "./schemaless";

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
 * `pending` while the org flag or the backend probe loads: callers hold their
 * reads until then, so a project never reads from one backend and then
 * switches to another.
 */
export function useContentBackend(
  virtualMcpId: string | null | undefined,
  branch: string | null | undefined,
): ContentBackend {
  const { org } = useProjectContext();
  const flagEnabled = useOrgFlagState("site_editor_content_protocol");
  const { connection } = useDecoServeConnection(virtualMcpId);
  const { url: tunnel } = useLocalPreviewUrl(virtualMcpId);
  const { runtime } = useSessionRuntime(virtualMcpId);
  const threadId = useOptionalChatTask()?.taskId ?? null;
  // The daemon answers once the working tree is there; before that the
  // sandbox is booting and the editor keeps today's (legacy) boot UX.
  const workingTreeReady = isWorkingTreeReadyPhase(
    useSandboxEvents().lifecycle.phase,
  );

  const githubEnabled =
    !!org.slug &&
    !!flagEnabled &&
    !connection &&
    !tunnel &&
    runtime === "cms" &&
    !!virtualMcpId &&
    !!branch;
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
    retry: 2,
    // A failed probe reads as v7 (legacy) and is retried quietly. A site
    // already known to be v8 keeps its data through a failed refetch.
    refetchInterval: (query) =>
      query.state.status === "error" ? PROBE_RETRY_MS : false,
  });

  const sandboxEnabled =
    !!org.slug &&
    !!flagEnabled &&
    !connection &&
    !tunnel &&
    runtime === "sandbox" &&
    workingTreeReady &&
    !!virtualMcpId &&
    !!branch;
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
    retry: 2,
    refetchInterval: (query) =>
      query.state.status === "error" ? PROBE_RETRY_MS : false,
  });

  // No flag: a connection exists only once its link was pasted or opened.
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
    // Also re-probed while there is no schema, so `deco schema` is picked up
    // on its own.
    refetchInterval: (query) =>
      query.state.status === "error" || query.state.data?.hasSchema === false
        ? PROBE_RETRY_MS
        : false,
  });

  const decision = selectContentBackend({
    hasProject: !!virtualMcpId,
    flagEnabled,
    hasServeConnection: !!connection,
    hasLocalTunnel: !!tunnel,
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
  if (local.data) {
    return toBackend("local", local.data, `:serve:${connection!.endpoint}`);
  }
  // Still retrying after a failure: `deco serve` is down or restarting.
  if (local.isError || local.failureCount > 0) {
    return {
      kind: "unavailable",
      source: "local",
      problem: classifyServeProbeError(local.error ?? local.failureReason),
    };
  }
  return { kind: "pending" };
}

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
