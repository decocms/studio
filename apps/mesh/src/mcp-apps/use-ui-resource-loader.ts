import { injectCSP } from "./csp-injector.ts";
import { UIResourceLoader, type ReadResourceFn } from "./resource-loader.ts";
import { useRef, useState } from "react";

const sharedLoader = new UIResourceLoader();

const UI_SELF_SCHEME = "ui://self/";

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

/** Derive /_widgets/ path from ui://self/<name> URI */
function deriveSelfWidgetUrl(uri: string): string | null {
  const withoutScheme = uri.slice(UI_SELF_SCHEME.length); // "counter" or "code?borderless=true"
  const [name, ...rest] = withoutScheme.split("?");
  if (!name) return null;
  const path = `/_widgets/${name}${rest.length ? `?${rest.join("?")}` : ""}`;
  return isValidWidgetUrl(path) ? path : null;
}

export function useUIResourceLoader(uri: string, readResource: ReadResourceFn) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadStartedRef = useRef(false);

  // ui://self/<name> — built-in widget: derive /_widgets/ path directly
  if (uri.startsWith(UI_SELF_SCHEME)) {
    const url = deriveSelfWidgetUrl(uri);
    if (url) return { html: null, url, loading: false, error: null };
    return {
      html: null,
      url: null,
      loading: false,
      error: "Invalid self widget URI",
    };
  }

  // Keep existing /_widgets/ path handling for backwards compatibility
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
