import { injectCSP } from "./csp-injector.ts";
import { UIResourceLoader, type ReadResourceFn } from "./resource-loader.ts";
import { useRef, useState } from "react";

const sharedLoader = new UIResourceLoader();

/** Only allow same-origin /_widgets/* paths, reject everything else */
function isValidWidgetUrl(uri: string): boolean {
  if (!uri.startsWith("/")) return false;
  try {
    const url = new URL(uri, window.location.origin);
    if (url.origin !== window.location.origin) return false;
    if (!url.pathname.startsWith("/_widgets/")) return false;
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function useUIResourceLoader(uri: string, readResource: ReadResourceFn) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadStartedRef = useRef(false);

  // If the URI is already a direct URL (not a ui:// resource URI), validate and use directly
  if (!uri.startsWith("ui://")) {
    if (isValidWidgetUrl(uri)) {
      return { html: null, url: uri, loading: false, error: null };
    }
    return {
      html: null,
      url: null,
      loading: false,
      error: "Invalid widget URL",
    };
  }

  if (!loadStartedRef.current && !html && !loading && !error) {
    loadStartedRef.current = true;
    queueMicrotask(() => {
      setLoading(true);
      (async () => {
        try {
          const content = await sharedLoader.load(uri, readResource);
          setHtml(injectCSP(content.html, { resourceCsp: content.csp }));
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load app");
        } finally {
          setLoading(false);
        }
      })();
    });
  }

  return { html, url: null, loading, error };
}
