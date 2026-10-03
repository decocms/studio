import { useQuery } from "@tanstack/react-query";
import {
  assertSupportedEndpoint,
  type ContentClient,
  createContentClient,
  type DescribeResult,
  ErrorCode,
  type SchemaGetResult,
} from "@decocms/shared/blocks-protocol";
import { useProjectContext } from "@/sdk";
import { useDecoServeConnection } from "@/hooks/use-deco-serve-connection";
import { useLocalPreviewUrl } from "@/hooks/use-local-preview-url";
import { useOrgFlagState } from "@/hooks/use-organization-settings";
import { useSessionRuntime } from "@/hooks/use-session-runtime";
import { KEYS } from "@/lib/query-keys";
import {
  type ContentBackend,
  type ProtocolBackend,
  selectContentBackend,
} from "./content-backend";
import { decoServeErrorReason } from "./deco-serve-status";

type FullSchema = Extract<SchemaGetResult, { notModified: false }>;

interface Probe {
  client: ContentClient;
  describe: DescribeResult;
  schema: FullSchema | null;
}

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

/** `describe` plus the schema, in one request. */
async function probe(client: ContentClient): Promise<Probe> {
  const [described, schema] = await client.batch([
    { method: "describe" },
    { method: "schema.get" },
  ]);
  if (!described?.ok) throw described?.error ?? new Error("no describe");
  const describe = assertSupportedEndpoint(described.result as DescribeResult);
  if (schema?.ok) {
    return { client, describe, schema: schema.result as FullSchema };
  }
  if (schema?.error.code === ErrorCode.NotFound) {
    return { client, describe, schema: null };
  }
  throw schema?.error ?? new Error("no schema.get");
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

  const githubEnabled =
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
      const client = createContentClient({
        endpoint: githubContentEndpoint({
          orgSlug: org.slug,
          virtualMcpId: virtualMcpId!,
          branch: branch!,
        }),
      });
      const result = await probe(client);
      // No committed schema: a legacy site.
      return result.schema ? result : null;
    },
    enabled: githubEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 2,
  });

  const localEnabled = !!flagEnabled && !!connection;
  const local = useQuery({
    queryKey: KEYS.contentBackend(
      org.slug,
      virtualMcpId ?? "",
      "local",
      connection?.endpoint ?? "",
      connection?.token ?? "",
    ),
    queryFn: () =>
      probe(
        createContentClient({
          endpoint: connection!.endpoint,
          token: connection!.token,
        }),
      ),
    enabled: localEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
    // Reconnects on its own once `deco serve` is (re)started.
    refetchInterval: (query) =>
      query.state.status === "error" ? 5_000 : false,
  });

  const decision = selectContentBackend({
    flagEnabled,
    hasServeConnection: !!connection,
    hasLocalTunnel: !!tunnel,
    runtime,
    githubSchema: github.data
      ? "present"
      : github.data === null || github.isError
        ? "absent"
        : "loading",
  });

  if (decision === "pending") return { kind: "pending" };
  if (decision === "legacy") return { kind: "legacy" };
  if (decision === "protocol-github") {
    return toBackend("github", github.data!, "");
  }
  if (local.data) {
    return toBackend("local", local.data, `:serve:${connection!.endpoint}`);
  }
  if (local.isError) {
    return {
      kind: "unavailable",
      source: "local",
      reason: decoServeErrorReason(local.error),
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
    schema: probed.schema,
    cacheKeySuffix,
  };
}
