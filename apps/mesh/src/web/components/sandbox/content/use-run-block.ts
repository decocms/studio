import { useMutation } from "@tanstack/react-query";

interface RunBlockInput {
  resolveType: string;
  props: Record<string, unknown>;
}

/**
 * Build the invoke run URL Deco expects:
 * `GET <preview>/live/invoke/<resolveType>` with the resolveType RAW in the
 * path (slashes intact). Unlike `/live/previews/*` (which always renders an
 * HTML preview page), `/live/invoke/*` returns the block's structured JSON
 * result. Search params:
 *
 * - `__cb` — CDN cache-buster (time-encoded) so we always miss the edge cache.
 * - `__decoFBT=0` — disables loader caching for this request.
 * - `__d` — enables debug mode; the value is a free-form correlation id.
 * - `props` — `btoa(encodeURIComponent(JSON.stringify(props)))`; the runtime's
 *   `bodyFromUrl` decodes with `JSON.parse(decodeURIComponent(atob(props)))`
 *   (the URI-encoding step keeps `btoa` safe for non-Latin1 characters).
 *
 * `nowMs` is a parameter so the function stays pure and testable.
 */
export function buildInvokeRunUrl(
  previewUrl: string,
  resolveType: string,
  props: Record<string, unknown>,
  nowMs: number,
): string {
  const url = new URL(`/live/invoke/${resolveType}`, previewUrl);
  url.searchParams.set("__cb", nowMs.toString(36));
  url.searchParams.set("__decoFBT", "0");
  url.searchParams.set("__d", `run-${nowMs.toString(36)}`);
  url.searchParams.set(
    "props",
    btoa(encodeURIComponent(JSON.stringify(props))),
  );
  return url.href;
}

/**
 * Live-invoke a loader/action against the running sandbox preview and return
 * its structured result.
 *
 * The fetch runs CLIENT-side, straight at the preview origin — exactly like
 * `useLiveMeta` and the dynamic-options field. This matters for desktop-linked
 * sandboxes: the preview lives at `<handle>.localhost:<port>`, which the browser
 * resolves but the mesh server (Bun) does not.
 */
async function invokeBlock(
  previewUrl: string,
  { resolveType, props }: RunBlockInput,
): Promise<unknown> {
  const res = await fetch(
    buildInvokeRunUrl(previewUrl, resolveType, props, Date.now()),
  );

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

export function useRunBlock(previewUrl: string | null) {
  return useMutation<unknown, Error, RunBlockInput>({
    mutationFn: (input) => {
      if (!previewUrl) {
        throw new Error(
          "Preview isn't running yet — start the sandbox and try again.",
        );
      }
      return invokeBlock(previewUrl, input);
    },
  });
}
