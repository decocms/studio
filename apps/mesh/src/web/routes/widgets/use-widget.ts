import { useApp, useHostStyles } from "@modelcontextprotocol/ext-apps/react";
import { useState } from "react";

export function useWidget<T extends Record<string, unknown>>() {
  const [args, setArgs] = useState<T | null>(null);
  const { app, isConnected, error } = useApp({
    appInfo: { name: "MeshWidget", version: "1.0.0" },
    capabilities: {},
    onAppCreated: (a) => {
      a.ontoolinput = (p) => setArgs((p.arguments ?? {}) as T);
    },
  });
  // Pass initialContext so styles are applied immediately on mount, not on first change
  useHostStyles(app, app?.getHostContext());
  return { args, isConnected, error };
}
