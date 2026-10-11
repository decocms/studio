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
import { useProjectContext, useVirtualMCP } from "@/sdk";
import { buildSandboxUrl } from "@/sdk/sandbox-url";
import { useOptionalChatTask } from "@/components/chat/chat-context";
import { isWorkingTreeReadyPhase } from "@decocms/sandbox/shared";
import { useSandboxEvents } from "@/components/sandbox/hooks/use-sandbox-events";
import {
  TabDecoServeConnectionContext,
  useDecoServeConnection,
} from "@/hooks/use-deco-serve-connection";
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
  matchServeSite,
  NotDecoServeError,
  probeRetryDelay,
  saveLastConnection,
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
  // Null on a v7 site: only Blocks v8 uses a `deco serve` (Localhost).
  const { connection } = useDecoServeConnection(virtualMcpId);
  const { url: tunnel } = useLocalPreviewUrl(virtualMcpId);
  const { runtime, isBlocksV8 } = useSessionRuntime(virtualMcpId);
  // The account-less `/site-editor` is v8 by definition (only a v8
  // `deco serve` answers it).
  const tabConnection = useContext(TabDecoServeConnectionContext);
  const isV8Project = isBlocksV8 || tabConnection !== null;
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
    ...backgroundProbeRetry(isV8Project),
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
    ...backgroundProbeRetry(isV8Project),
  });

  // This project's site id, for `matchServeSite`, and the public key its
  // repository commits (filled in below, read by the local probe's poll).
  const project = useVirtualMCP(tabConnection ? null : virtualMcpId);
  const siteSlug =
    typeof project?.metadata?.siteSlug === "string"
      ? project.metadata.siteSlug
      : null;
  const queryClient = useQueryClient();
  const committedKeyQuery = KEYS.contentBackend(
    org.slug,
    virtualMcpId ?? "",
    branch ?? "",
    "github-describe",
  );
  const serveMismatch = (data: Probe | undefined) => {
    if (!data || tabConnection) return false;
    const match = matchServeSite(data.describe, {
      siteSlug,
      committedPublicKey: committedKeyOf(
        queryClient.getQueryState<string | null>(committedKeyQuery),
      ),
    });
    return match !== "pending" && !match.ok;
  };

  // No flag: a connection exists only on a v8 site, once someone chose
  // Localhost or opened the link `deco serve` printed.
  const localEnabled = !!connection;
  const local = useQuery({
    queryKey: KEYS.contentBackend(
      org.slug,
      virtualMcpId ?? "",
      "local",
      connection?.endpoint ?? "",
    ),
    queryFn: async () => {
      const result = await probe(
        createContentClient({ endpoint: connection!.endpoint }),
      );
      // Tried first the next time someone chooses Localhost.
      saveLastConnection(connection!);
      return result;
    },
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
    // on its own, and while it serves another site (or can't say which), so
    // starting `deco serve` in the right folder connects on its own.
    refetchInterval: (query) =>
      query.state.status === "error" ||
      query.state.data?.hasSchema === false ||
      serveMismatch(query.state.data)
        ? PROBE_RETRY_MS
        : false,
  });

  // The site match of a project's `deco serve` (see `matchServeSite`): the
  // public key committed to the project's repository, read only when a newer
  // `deco serve` doesn't name its site.
  const needsCommittedKey =
    !!local.data &&
    !tabConnection &&
    !(
      typeof (local.data.describe as { site?: unknown }).site === "string" &&
      siteSlug
    );
  const committed = useQuery({
    queryKey: committedKeyQuery,
    queryFn: async (): Promise<string | null> => {
      const client = createContentClient({
        endpoint: githubContentEndpoint({
          orgSlug: org.slug,
          virtualMcpId: virtualMcpId!,
          branch: branch!,
        }),
      });
      const described = await client.describe();
      return described.secrets?.publicKey ?? null;
    },
    enabled: needsCommittedKey && !!org.slug && !!virtualMcpId && !!branch,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });

  const decision = selectContentBackend({
    hasProject: !!virtualMcpId,
    isV8Project,
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
    const match = tabConnection
      ? ({ ok: true } as const)
      : matchServeSite(local.data.describe, {
          siteSlug,
          committedPublicKey: committedKeyOf(committed),
        });
    if (match === "pending") return { kind: "pending" };
    if (!match.ok) {
      // Another site's `deco serve`: never used. The probe keeps polling, so
      // starting the right one connects on its own.
      return { kind: "unavailable", source: "local", problem: match.problem };
    }
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

/** The committed public key once read: `null` when the repository has none
 *  (or it can't be read), `undefined` while it loads. */
function committedKeyOf(
  state: { status: string; data?: string | null } | undefined,
): string | null | undefined {
  if (state?.status === "success") return state.data ?? null;
  if (state?.status === "error") return null;
  return undefined;
}

/**
 * How the GitHub and sandbox probes retry. A v8 project waits on the answer,
 * so a failure is retried until it recovers. A v7 project never waits: one
 * quiet background try (an upgrade branch may answer v8), and no re-poll, so
 * a v7 site makes no repeated requests.
 */
export function backgroundProbeRetry(isV8Project: boolean) {
  return isV8Project
    ? {
        retry: 2,
        // A site already known to be v8 keeps its data through a failed
        // refetch.
        refetchInterval: (query: { state: { status: string } }) =>
          query.state.status === "error" ? PROBE_RETRY_MS : false,
      }
    : { retry: 1, refetchInterval: false as const };
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
