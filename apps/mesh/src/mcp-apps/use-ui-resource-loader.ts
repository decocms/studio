import { injectCSP } from "./csp-injector.ts";
import { UIResourceLoader, type ReadResourceFn } from "./resource-loader.ts";
import { useRef, useState } from "react";

const sharedLoader = new UIResourceLoader();

export function useUIResourceLoader(uri: string, readResource: ReadResourceFn) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadStartedRef = useRef(false);

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

  return { html, loading, error };
}
