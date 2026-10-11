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
import { useOrgFlagState } from "@/hooks/use-organization-settings";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { KEYS } from "@/lib/query-keys";
import {
  type ContentBackend,
  contentProbesEnabled,
  isV8Schema,
  type ProtocolBackend,
  selectContentBackend,
} from "./content-backend";
import {
  classifyServeProbeError,
  matchServeSite,
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

/** How often a repository with no committed public key is re-read. */
const COMMITTED_KEY_RECHECK_MS = 30_000;

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
 * `pending` while the org flag or the backend probe loads: callers hold their
 * reads until then, so it never reads from the v7 backend and then switches.
 */
export function useContentBackend(
  virtualMcpId: string | null | undefined,
  branch: string | null | undefined,
): ContentBackend {
  const { org } = useProjectContext();
  const flagEnabled = useOrgFlagState("site_editor_content_protocol");
  // Null on a v7 site: only Blocks v8 uses a `deco serve` (Localhost).
  const { connection } = useDecoServeConnection(virtualMcpId);
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

  const probes = contentProbesEnabled({
    isV8Project,
    flagEnabled,
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

  // This project's site id, for `matchServeSite`, and the public key its
  // repository commits (filled in below, read by the local probe's poll).
  const project = useVirtualMCP(tabConnection ? null : virtualMcpId);
  const siteSlug =
    typeof project?.metadata?.siteSlug === "string"
      ? project.metadata.siteSlug
      : null;
  const queryClient = useQueryClient();
  // Per project, not per draft: the server reads main's `.deco/secrets.pub`
  // whatever the draft.
  const committedKeyQuery = KEYS.contentBackend(
    org.slug,
    virtualMcpId ?? "",
    "committed-public-key",
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
    // on its own, and while it serves another site (or can't say which), so
    // starting `deco serve` in the right folder connects on its own.
    refetchInterval: (query) =>
      query.state.status === "error" ||
      query.state.data?.hasSchema === false ||
      serveMismatch(query.state.data)
        ? PROBE_RETRY_MS
        : false,
  });

  // Once connected, the site check keeps running: `describe` is re-read on
  // every poll, so a `deco serve` restarted in another site's folder on the
  // same port is caught without waiting for a failed read or write.
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
      const described = await local.data!.client.describe();
      // A different server answered: probe it again (its schema, too).
      const probed = queryClient.getQueryData<Probe>(localKey);
      if (siteIdentity(described) !== siteIdentity(probed?.describe)) {
        void queryClient.invalidateQueries(
          { queryKey: localKey, exact: true },
          { cancelRefetch: false },
        );
      }
      return described;
    },
    enabled: !!local.data && !tabConnection,
    refetchInterval: PROBE_RETRY_MS,
    retry: false,
  });
  const describe = liveDescribe.data ?? local.data?.describe;

  // The site match of a project's `deco serve` (see `matchServeSite`): the
  // public key committed to the project's repository, read only when a newer
  // `deco serve` doesn't name its site.
  const needsCommittedKey =
    !!describe &&
    !tabConnection &&
    !(typeof (describe as { site?: unknown }).site === "string" && siteSlug);
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
    // A failed read is not an answer: re-read until it is. A repository with
    // no key is re-read now and then, so adding one connects on its own.
    refetchInterval: (query) =>
      query.state.status === "error"
        ? PROBE_RETRY_MS
        : query.state.data === null
          ? COMMITTED_KEY_RECHECK_MS
          : false,
  });

  const decision = selectContentBackend({
    hasProject: !!virtualMcpId,
    isV8Project,
    flagEnabled,
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
  if (local.data) {
    return localBackendOf({
      probed: local.data,
      describe: describe ?? local.data.describe,
      endpoint: connection!.endpoint,
      verifySite: !tabConnection,
      siteSlug,
      committed,
    });
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

/**
 * A connected `deco serve`'s backend once the site check (`matchServeSite`)
 * has run on its latest `describe`: `protocol` for this project's site,
 * `unavailable` (with the reason) for another site or one that can't be
 * told, `pending` while the committed public key is still being read.
 * `/site-editor` belongs to no project and skips the check (`verifySite`).
 */
export function localBackendOf(input: {
  probed: Probe;
  describe: DescribeResult;
  endpoint: string;
  verifySite: boolean;
  siteSlug: string | null;
  committed: { status: string; data?: string | null } | undefined;
}): ContentBackend {
  const match = input.verifySite
    ? matchServeSite(input.describe, {
        siteSlug: input.siteSlug,
        committedPublicKey: committedKeyOf(input.committed),
      })
    : ({ ok: true } as const);
  if (match === "pending") return { kind: "pending" };
  if (!match.ok) {
    // Never used. The probe keeps polling, so starting the right
    // `deco serve` connects on its own.
    return { kind: "unavailable", source: "local", problem: match.problem };
  }
  return toBackend(
    "local",
    { ...input.probed, describe: input.describe },
    `:serve:${input.endpoint}`,
  );
}

/**
 * The committed public key once read: `null` when the repository has none,
 * `undefined` while it loads or while a failed read is retried (a GitHub
 * hiccup is not "no key", so it never reads as `site-unverified`). After a
 * successful read, a failed re-read keeps that answer.
 */
export function committedKeyOf(
  state: { status: string; data?: string | null } | undefined,
): string | null | undefined {
  if (state?.data !== undefined) return state.data ?? null;
  return undefined;
}

/** Which site a `describe` says it serves (its id and public key). */
function siteIdentity(describe: DescribeResult | undefined): string {
  const d = describe as
    | { site?: unknown; secrets?: { publicKey?: string } | null }
    | undefined;
  return JSON.stringify([
    typeof d?.site === "string" ? d.site : null,
    d?.secrets?.publicKey ?? null,
  ]);
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
