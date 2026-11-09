import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { installMockApi } from "./mock-api";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@decocms/ui/components/tooltip.tsx";
import { ProjectContextProvider } from "@/sdk/context/project-context";
import { KEYS } from "@/lib/query-keys";
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";
import { ScenarioLoader } from "./scenario";
import { ORG, PROJECT } from "./data";
import { readFixture } from "./scenario-data";
import "../../../index.css";

installMockApi();
const route = createRootRoute({ component: ScenarioLoader });
const router = createRouter({
  routeTree: route,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});

const client = new QueryClient({
  defaultOptions: {
    queries: {
      enabled: false,
      retry: false,
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
  },
});
client.setQueryData(KEYS.organizationSettings(ORG.id), {
  organizationId: ORG.id,
  flags: null,
});
client.setQueryData(KEYS.taskBoardSprints(ORG.id), []);
client.setQueryData(["localStorage", LOCALSTORAGE_KEYS.preferences()], {
  language: "pt-BR",
  theme: "light",
  toolApprovalLevel: "readonly",
  enableNotifications: false,
  enableSounds: false,
  taskBoardLaneVisibility: {},
  collapsedTaskBoardLanes: [],
});
const fixture = readFixture();
const previewOrg = fixture
  ? {
      ...ORG,
      name: fixture.organization,
      slug: fixture.organization.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    }
  : ORG;
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <TooltipProvider>
          <ProjectContextProvider org={previewOrg} project={PROJECT}>
            <RouterProvider router={router} />
          </ProjectContextProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
