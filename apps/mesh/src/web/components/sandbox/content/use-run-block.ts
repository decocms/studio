import { useMutation } from "@tanstack/react-query";

interface RunBlockInput {
  resolveType: string;
  props: Record<string, unknown>;
}

/**
 * Build the block-preview run URL Deco expects (same contract the admin uses):
 * `GET <preview>/live/previews/<resolveType>` with the resolveType RAW in the
 * path (slashes intact) and:
 *
 * - `__cb` — CDN cache-buster (time-encoded) so we always miss the edge cache.
 * - `__decoFBT=0` — disables loader caching for this request.
 * - `__d` — enables debug mode; the value is a free-form correlation id.
 * - `props` — `btoa(encodeURIComponent(JSON.stringify(props)))`, mirroring the
 *   admin's `encodeProps` (the runtime decodes with
 *   `decodeURIComponent(atob(props))`; the URI-encoding step keeps `btoa` safe
 *   for non-Latin1 characters).
 *
 * `nowMs` is a parameter so the function stays pure and testable.
 */
export function buildPreviewRunUrl(
  previewUrl: string,
  resolveType: string,
  props: Record<string, unknown>,
  nowMs: number,
): string {
  const url = new URL(`/live/previews/${resolveType}`, previewUrl);
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
    buildPreviewRunUrl(previewUrl, resolveType, props, Date.now()),
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
