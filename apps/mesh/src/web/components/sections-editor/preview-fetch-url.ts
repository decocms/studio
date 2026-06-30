interface DecofileFetchInput {
  orgSlug: string;
  virtualMcpId: string;
  branch: string;
  previewUrl?: string | null;
  getFallbackPreviewUrl?: () => string | null;
}

function isBrowserReachableLocalPreview(previewUrl: string): boolean {
  try {
    const { hostname } = new URL(previewUrl);
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

function readPreviewUrlFromDocument(): string | null {
  if (typeof document === "undefined") return null;
  const iframes = Array.from(document.querySelectorAll("iframe"));
  for (const iframe of iframes) {
    const src = iframe.getAttribute("src");
    if (src && isBrowserReachableLocalPreview(src)) return src;
  }
  return null;
}

export function buildDecofileFetchUrl(input: DecofileFetchInput): string {
  const browserPreviewUrl =
    input.previewUrl ??
    input.getFallbackPreviewUrl?.() ??
    readPreviewUrlFromDocument();
  if (browserPreviewUrl && isBrowserReachableLocalPreview(browserPreviewUrl)) {
    return new URL("/.decofile", browserPreviewUrl).toString();
  }

  const search = new URLSearchParams({ path: "/.decofile" });
  return `/api/${input.orgSlug}/sandbox/${encodeURIComponent(input.virtualMcpId)}/${encodeURIComponent(input.branch)}/preview-fetch?${search.toString()}`;
}
