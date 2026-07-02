import { useMutation } from "@tanstack/react-query";

interface RunBlockInput {
  resolveType: string;
  props: Record<string, unknown>;
}

/**
 * Build the single-invoke URL Deco expects:
 * `POST <preview>/deco/invoke/<encoded resolveType>` with `{ props }` as body.
 * Same shape as the product-list preview's server route, but the fetch runs in
 * the browser (see below).
 */
function buildInvokeUrl(previewUrl: string, resolveType: string): string {
  const base = previewUrl.replace(/\/+$/, "");
  return `${base}/deco/invoke/${encodeURIComponent(resolveType)}`;
}

/**
 * Live-invoke a loader/action against the running sandbox preview and return its
 * structured result.
 *
 * The fetch runs CLIENT-side, straight at the preview origin — exactly like
 * `useLiveMeta` and the dynamic-options field. This matters for desktop-linked
 * sandboxes: the preview lives at `<handle>.localhost:<port>`, which the browser
 * resolves but the mesh server (Bun) does not — routing through the server
 * `preview-invoke` proxy there fails with "Preview unreachable".
 */
async function invokeBlock(
  previewUrl: string,
  { resolveType, props }: RunBlockInput,
): Promise<unknown> {
  const res = await fetch(buildInvokeUrl(previewUrl, resolveType), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ props }),
  });

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
