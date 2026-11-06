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
import { cmsDraftRpcEndpoint, cmsSiteOf, ensureCmsDraft } from "./cms-api";
import { createHostedRpc, type HostedRpc } from "./hosted-content";
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
  type ProbeAnswer,
  type ProtocolBackend,
  readFailed,
  selectContentBackend,
} from "./content-backend";
import { useBlocksV8Project } from "@/hooks/use-blocks-v8-project";
import {
  classifyServeProbeError,
  NotDecoServeError,
  probeRetryDelay,
} from "./deco-serve-connection";
import { isSchemaAbsent } from "./schemaless";

export interface Probe {
  client: ContentClient;
  /** The hosted CMS's draft endpoint, for `cms.index` and `cms.blocks`. */
  hosted?: HostedRpc;
  describe: DescribeResult;
  /** Whether the endpoint has a schema (see `isSchemaAbsent`). */
  hasSchema: boolean;
}

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
 * Probes Studio's hosted backend (the latest release plus the CDN draft;
 * asked only on a v8 project): the probe, or {@link GITHUB_SITE_NOT_OWNED}
 * when the project doesn't own its site.
 */
export async function probeGithub(
  endpoint: string,
  doFetch: (request: Request) => Promise<Response> = (request) =>
    fetch(request),
): Promise<Probe | typeof GITHUB_SITE_NOT_OWNED> {
  const client = createContentClient({
    endpoint,
    fetch: async (request) => {
      const response = await doFetch(request);
      if (await isSiteNotOwnedResponse(response)) throw new SiteNotOwnedError();
      return response;
    },
  });
  try {
    return await probe(client);
  } catch (error) {
    if (error instanceof SiteNotOwnedError) return GITHUB_SITE_NOT_OWNED;
    throw error;
  }
}

/**
 * The hosted backend's probe. Its rpc route answers 404 `draft_not_found`
 * while the draft has no row (contract §4.8), and only `POST /drafts`
 * creates one (§4.5, idempotent), so the editor's draft is ensured first:
 * on a new thread branch, or after `deco drafts discard` of it, the probe
 * would otherwise fail forever, since the pointer read that also ensures
 * the draft waits for the probe to succeed.
 */
export async function probeHosted(
  endpoint: string,
  ensureDraft: () => Promise<unknown>,
  doFetch?: (request: Request) => Promise<Response>,
): ReturnType<typeof probeGithub> {
  await ensureDraft();
  const probed = await probeGithub(endpoint, doFetch);
  if (probed === GITHUB_SITE_NOT_OWNED) return probed;
  return { ...probed, hosted: createHostedRpc(endpoint, doFetch) };
}

/** How often a failed probe is retried, so a backend recovers on its own. */
const PROBE_RETRY_MS = 5_000;

/**
 * Studio's hosted backend for one project and branch: the hosted CMS's
 * draft named after the branch, on the project's site (`cms-api.ts`). A
 * project that names no site has no hosted draft to edit.
 */
function hostedContentEndpoint(params: {
  orgSlug: string;
  site: string | null;
  branch: string;
}): string {
  if (!params.site) throw new Error("this project names no site");
  return cmsDraftRpcEndpoint(params.site, params.branch);
}

/**
 * A sandbox's content protocol: Studio serves it over the sandbox's working
 * tree, with the same session auth and claim as the sandbox's other routes.
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
  if (isSchemaAbsent(schema)) return { client, describe, hasSchema: false };
  if (schema.ok) return { client, describe, hasSchema: true };
  throw schema.error;
}

/**
 * Probes Studio's content protocol over a sandbox's working tree (asked only
 * on a v8 project). Any failure, a 404 from a session whose sandbox is gone
 * included, is an error the editor retries.
 */
export function probeSandbox(
  endpoint: string,
  doFetch: (request: Request) => Promise<Response> = (request) =>
    fetch(request),
): Promise<Probe> {
  return probe(createContentClient({ endpoint, fetch: doFetch }));
}

/**
 * The content backend of a project's editor (see `selectContentBackend`).
 * The project's "Blocks v8 site" switch decides v7 (`legacy`, as on main)
 * or v8 in every mode; a v8 project is `pending` until its mode's backend
 * answers (Localhost: the `deco serve`; Sandbox: Studio over its working
 * tree; GitHub: the hosted CMS), so callers hold their reads until then.
 */
export function useContentBackend(
  virtualMcpId: string | null | undefined,
  branch: string | null | undefined,
): ContentBackend {
  const { org } = useProjectContext();
  // Null on a v7 project: only Blocks v8 uses a `deco serve` (Localhost). On
  // the account-less `/site-editor` it is the page's own connection.
  const { connection } = useDecoServeConnection(virtualMcpId);
  const { runtime } = useSessionRuntime(virtualMcpId);
  const tabConnection = useContext(TabDecoServeConnectionContext);
  const v8 = useBlocksV8Project(virtualMcpId);
  // The hosted CMS keys its drafts on the project's site.
  const site = cmsSiteOf(useVirtualMCP(virtualMcpId)?.metadata);
  const mode = contentMode({ hasServeConnection: !!connection, runtime });
  const threadId = useOptionalChatTask()?.taskId ?? null;
  // The sandbox answers once its working tree is there. Before its first
  // answer the editor waits (pending); once it answered for this thread, a
  // restart, hibernate or re-clone keeps that answer (`sandboxSiteAnswer`).
  const workingTreeReady = isWorkingTreeReadyPhase(
    useSandboxEvents().lifecycle.phase,
  );

  const queryClient = useQueryClient();
  const probes = contentProbesEnabled({ mode, v8, workingTreeReady });
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
      probeHosted(
        hostedContentEndpoint({
          orgSlug: org.slug,
          site,
          branch: branch!,
        }),
        () => ensureCmsDraft(site!, branch!),
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
    queryFn: () =>
      probeSandbox(
        sandboxContentEndpoint({
          orgSlug: org.slug,
          virtualMcpId: virtualMcpId!,
          branch: branch!,
          threadId,
        }),
      ),
    enabled: sandboxEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    ...V8_PROBE_RETRY,
  });

  // A connection exists only on a v8 project, once someone chose Localhost,
  // or on `/site-editor`.
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
    // Also re-probed while there is no schema, so `deco schema` is picked
    // up on its own.
    refetchInterval: (query) =>
      query.state.status === "error" || query.state.data?.hasSchema === false
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
    runtime,
    v8,
    githubSite:
      github.data === GITHUB_SITE_NOT_OWNED
        ? "not-owned"
        : github.data
          ? "ready"
          : readFailed(github)
            ? "error"
            : "loading",
    sandboxSite: sandboxSiteAnswer({
      data: sandbox.data,
      // The failure holds through a re-poll until a probe succeeds.
      isError: readFailed(sandbox),
      workingTreeReady,
    }),
  });

  if (decision === "pending") return { kind: "pending" };
  // The sandbox failed before its first answer: still waiting, retried.
  if (decision === "retrying-sandbox") {
    return { kind: "pending", retrying: "sandbox" };
  }
  if (decision === "legacy") return { kind: "legacy" };
  if (decision === "protocol-github") {
    return { ...toBackend("github", github.data as Probe, ""), site };
  }
  // A v8 site another project owns: the editor guides (no retry).
  if (decision === "site-not-owned-github") {
    return { kind: "unavailable", source: "github", siteNotOwned: true };
  }
  if (decision === "protocol-sandbox") {
    return toBackend("sandbox", sandbox.data!, ":sandbox");
  }
  // Studio's hosted backend failed (a GitHub or storage hiccup): retried
  // every PROBE_RETRY_MS, never the v7 editor in the meantime.
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
 * The sandbox's answer for `selectContentBackend`. Once the sandbox
 * answered for this thread (the probe's key is per thread and branch), that
 * answer holds while the working tree isn't ready: a restart, hibernate or
 * re-clone keeps the protocol. Before the first answer, a working tree that
 * isn't there yet is `unavailable` (the editor waits).
 */
export function sandboxSiteAnswer(input: {
  data: Probe | undefined;
  isError: boolean;
  workingTreeReady: boolean;
}): ProbeAnswer | "unavailable" {
  if (input.data !== undefined) return "ready";
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
 * doesn't decide v8 (the project's switch did); no schema yet is the
 * schemaless guide. The latest probe wins: once it fails, the editor and the
 * Localhost row say it isn't answering, and connect again once it answers.
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
 * so a failure is re-polled until it recovers; a backend that answered
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
    ...(probed.hosted ? { hosted: probed.hosted } : {}),
  };
}
