/**
 * Local-Dev Discovery Hook
 *
 * Polls the local-dev discovery endpoint to find running local-dev daemons
 * that haven't been linked as projects yet.
 */

import { useQuery } from "@tanstack/react-query";
import { KEYS } from "../lib/query-keys";

export interface DiscoveredInstance {
  port: number;
  root: string;
  version: string;
}

interface DiscoverResponse {
  instances: DiscoveredInstance[];
}

const isLocalhost =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1");

export function useLocalDevDiscovery() {
  return useQuery({
    queryKey: KEYS.localDevDiscovery(),
    queryFn: async () => {
      const res = await fetch("/api/local-dev/discover", {
        credentials: "include",
      });
      if (!res.ok) return [];
      const data = (await res.json()) as DiscoverResponse;
      return data.instances;
    },
    enabled: isLocalhost,
    refetchInterval: 5000,
    staleTime: 4000,
  });
}
