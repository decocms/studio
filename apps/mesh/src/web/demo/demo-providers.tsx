/**
 * Demo Mode — provider shell.
 *
 * Mirrors the real provider stack just enough to mount Studio components in a
 * fully-mocked, network-free context:
 *  - `ProjectContextProvider` with a mock org/project (real `useOrg` /
 *    `useProjectContext` / collection hooks resolve against it).
 *  - A dedicated `QueryClient` with `staleTime: Infinity`, `retry: false`,
 *    `refetchOnWindowFocus: false`, so any real hook that reads the cache gets
 *    seeded fixtures and never hits the network.
 *
 * It deliberately omits the auth gate (`RequiredAuthLayout` / `OrgAccessGate`)
 * — the demo is unauthenticated and public.
 */
import { useState, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectContextProvider } from "@decocms/mesh-sdk";

export const DEMO_ORG = {
  id: "demo-org",
  name: "Acme",
  slug: "acme",
  logo: null,
} as const;

export const DEMO_PROJECT = {
  id: "demo-project",
  slug: "default",
  name: "Default",
} as const;

function createDemoQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: Infinity,
        gcTime: Infinity,
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnMount: false,
        refetchOnReconnect: false,
      },
    },
  });
}

export function DemoProviders({ children }: PropsWithChildren) {
  const [queryClient] = useState(createDemoQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ProjectContextProvider org={DEMO_ORG} project={DEMO_PROJECT}>
        {children}
      </ProjectContextProvider>
    </QueryClientProvider>
  );
}
