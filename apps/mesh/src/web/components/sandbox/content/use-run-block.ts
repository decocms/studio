import { useMutation } from "@tanstack/react-query";

interface RunBlockInput {
  resolveType: string;
  props: Record<string, unknown>;
}

/** Sandbox coordinates the studio preview-invoke proxy route is keyed by. */
export interface RunBlockSandboxRef {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
}

/** Cap on a single run — mirrors the proxy's upstream invoke timeout. */
const RUN_TIMEOUT_MS = 30_000;

/**
 * Studio proxy path for a preview invoke:
 * `POST /api/:org/sandbox/:virtualMcpId/:branch/preview-invoke` with a
 * block-ref body (`{ __resolveType, ...props }`). The proxy re-issues it as
 * `POST <preview>/deco/invoke/<resolveType>` with the props as JSON body.
 *
 * Going through the studio (same-origin) instead of fetching the preview
 * directly keeps the browser out of CORS territory — previews don't send
 * `Access-Control-Allow-Origin` for `/deco/invoke`.
 */
export function buildPreviewInvokePath(ref: RunBlockSandboxRef): string {
  return `/api/${ref.orgSlug}/sandbox/${encodeURIComponent(ref.virtualMcpId)}/${encodeURIComponent(ref.branch)}/preview-invoke`;
}

/**
 * Studio proxy path for a preview GET fetch:
 * `GET /api/:org/sandbox/:virtualMcpId/:branch/preview-fetch?path=<path>`.
 * The proxy fetches `<preview><path>` server-side (only an allowlisted set of
 * paths — `/.decofile`, `/`) so the browser stays out of CORS. Used to read the
 * site's homepage HTML for link-based entity discovery.
 */
export function buildPreviewFetchPath(
  ref: RunBlockSandboxRef,
  path: string,
): string {
  const base = `/api/${ref.orgSlug}/sandbox/${encodeURIComponent(ref.virtualMcpId)}/${encodeURIComponent(ref.branch)}/preview-fetch`;
  return `${base}?path=${encodeURIComponent(path)}`;
}

/**
 * Build the invoke URL for "Open result in new tab": a top-level GET
 * navigation to `<preview>/deco/invoke/<resolveType>` with the resolveType RAW
 * in the path (slashes intact). A navigation can't POST, so props ride in the
 * query — the runtime's `bodyFromUrl` decodes them on GET. (CORS doesn't apply
 * to top-level navigations, so hitting the preview origin directly is fine
 * here.) Search params:
 *
 * - `__cb` — CDN cache-buster (time-encoded) so we always miss the edge cache.
 * - `__decoFBT=0` — disables loader caching for this request.
 * - `__d` — enables debug mode; the value is a free-form correlation id.
 * - `props` — `btoa(encodeURIComponent(JSON.stringify(props)))`; the runtime
 *   decodes with `JSON.parse(decodeURIComponent(atob(props)))` (the
 *   URI-encoding step keeps `btoa` safe for non-Latin1 characters).
 *
 * `nowMs` is a parameter so the function stays pure and testable.
 */
export function buildInvokeRunUrl(
  previewUrl: string,
  resolveType: string,
  props: Record<string, unknown>,
  nowMs: number,
): string {
  const url = new URL(`/deco/invoke/${resolveType}`, previewUrl);
  url.searchParams.set("__cb", nowMs.toString(36));
  url.searchParams.set("__decoFBT", "0");
  url.searchParams.set("__d", `run-${nowMs.toString(36)}`);
  url.searchParams.set(
    "props",
    btoa(encodeURIComponent(JSON.stringify(props))),
  );
  return url.href;
}

async function invokeBlock(
  ref: RunBlockSandboxRef,
  { resolveType, props }: RunBlockInput,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(buildPreviewInvokePath(ref), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ __resolveType: resolveType, ...props }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "TimeoutError") {
      throw new Error(
        `Run timed out after ${RUN_TIMEOUT_MS / 1000}s — the block may be slow or the preview unresponsive.`,
      );
    }
    throw err;
  }

  const text = await res.text();
  let data: unknown = null;
  let parsed = false;
  try {
    data = text ? JSON.parse(text) : null;
    parsed = true;
  } catch {
    // Non-JSON body — fall through to the raw-text handling below.
  }

  if (!res.ok) {
    const message =
      parsed &&
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : text || `Run failed (${res.status})`;
    throw new Error(message);
  }

  return parsed ? data : text;
}

/**
 * Invoke a loader/action against the running sandbox preview (via the studio
 * preview-invoke proxy) and return its structured result.
 */
export function useRunBlock(ref: RunBlockSandboxRef) {
  return useMutation<unknown, Error, RunBlockInput>({
    mutationFn: (input) => invokeBlock(ref, input),
  });
}
