import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import * as realLive from "@/components/experiments/experiments-live";
import * as realV8 from "@/hooks/use-blocks-v8-project";
import * as realExperiments from "@/hooks/use-experiments";
import * as realSettings from "@/hooks/use-organization-settings";
import * as realTab from "@/layouts/main-panel-tabs/experiments-tab";
import * as realStudioTools from "@/lib/studio-tools";
import * as realSdk from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import * as realLocked from "./locked";
import * as realMonitorViews from "./monitor-views";

const state = {
  orgFlag: false,
  v8: new Set<string>(),
  projects: [] as Array<{ id: string; title: string; site: string }>,
};

const restore = {
  live: { ...realLive },
  v8: { ...realV8 },
  experiments: { ...realExperiments },
  settings: { ...realSettings },
  tab: { ...realTab },
  studioTools: { ...realStudioTools },
  sdk: { ...realSdk },
  locked: { ...realLocked },
  monitorViews: { ...realMonitorViews },
};
afterAll(() => {
  mock.module("@/components/experiments/experiments-live", () => restore.live);
  mock.module("@/hooks/use-blocks-v8-project", () => restore.v8);
  mock.module("@/hooks/use-experiments", () => restore.experiments);
  mock.module("@/hooks/use-organization-settings", () => restore.settings);
  mock.module("@/layouts/main-panel-tabs/experiments-tab", () => restore.tab);
  mock.module("@/lib/studio-tools", () => restore.studioTools);
  mock.module("@/sdk", () => restore.sdk);
  mock.module("./locked", () => restore.locked);
  mock.module("./monitor-views", () => restore.monitorViews);
});

mock.module("@/components/experiments/experiments-live", () => ({
  ...restore.live,
  ProjectExperimentsLive: ({ virtualMcpId }: { virtualMcpId: string }) => (
    <div data-testid="live-view">{virtualMcpId}</div>
  ),
}));
mock.module("@/layouts/main-panel-tabs/experiments-tab", () => ({
  ...restore.tab,
  ExperimentsTab: ({ virtualMcpId }: { virtualMcpId: string }) => (
    <div data-testid="crud-tab">{virtualMcpId}</div>
  ),
  ExperimentRow: ({ experiment }: { experiment: { name: string } }) => (
    <div data-testid="v7-row">{experiment.name}</div>
  ),
}));
mock.module("@/hooks/use-blocks-v8-project", () => ({
  ...restore.v8,
  useBlocksV8Project: (id: string | null | undefined) =>
    !!id && state.v8.has(id),
  blocksV8Project: (entity: { id: string } | null | undefined) =>
    !!entity && state.v8.has(entity.id),
}));
mock.module("@/hooks/use-organization-settings", () => ({
  ...restore.settings,
  useControlPlaneViews: () => ({ experiments: state.orgFlag }),
}));
mock.module("@/hooks/use-experiments", () => ({
  ...restore.experiments,
  experimentsQuery: (locator: string, _studio: unknown, site: string) => ({
    queryKey: KEYS.experiments(locator, site),
    queryFn: async () => [
      {
        id: `${site}-1`,
        name: `${site} test`,
        status: "running",
        updatedAt: "2026-11-01T00:00:00Z",
      },
    ],
  }),
}));
mock.module("@/lib/studio-tools", () => ({
  ...restore.studioTools,
  useStudioTools: () => ({}),
}));
mock.module("@/sdk", () => ({
  ...restore.sdk,
  useProjectContext: () => ({ org: { slug: "acme" }, locator: "acme/x" }),
  useVirtualMCPsNonBlocking: () => state.projects,
}));
mock.module("./locked", () => ({
  ...restore.locked,
  Locked: () => <div data-testid="locked" />,
}));
mock.module("./monitor-views", () => ({
  ...restore.monitorViews,
  useSiteProjects: () =>
    state.projects.map((p) => ({ ...p, icon: null, analyticsSite: p.site })),
}));

const { ExperimentsView } = await import("./experiments-view");

beforeEach(() => {
  state.orgFlag = false;
  state.v8 = new Set();
  state.projects = [];
});

const body = () => within(document.body);

async function renderView(ui: ReactNode) {
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/acme/monitoring"] }),
  });
  await router.load();
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Monitor › Experiments of one project", () => {
  test("a Blocks v8 project gets the read-only view, flag or not", async () => {
    state.v8 = new Set(["vm-8"]);
    await renderView(<ExperimentsView scopeId="vm-8" />);
    expect((await body().findByTestId("live-view")).textContent).toBe("vm-8");
    expect(body().queryByTestId("crud-tab")).toBeNull();
  });

  test("a v7 project keeps today's tab under the org's rollout", async () => {
    state.orgFlag = true;
    await renderView(<ExperimentsView scopeId="vm-7" />);
    expect((await body().findByTestId("crud-tab")).textContent).toBe("vm-7");
    expect(body().queryByTestId("live-view")).toBeNull();
  });

  test("a v7 project without the rollout stays locked", async () => {
    await renderView(<ExperimentsView scopeId="vm-7" />);
    expect(await body().findByTestId("locked")).toBeTruthy();
  });
});

describe("Monitor › Experiments of the org", () => {
  test("links each Blocks v8 project to its Experiments app", async () => {
    state.orgFlag = true;
    state.v8 = new Set(["vm-8"]);
    state.projects = [
      { id: "vm-7", title: "Store", site: "store" },
      { id: "vm-8", title: "Blocks store", site: "blocks" },
    ];
    await renderView(<ExperimentsView scopeId={null} />);
    expect((await body().findByTestId("v7-row")).textContent).toBe(
      "store test",
    );
    const blocks8 = body().getByTestId("monitor-blocks8-experiments");
    const link = within(blocks8).getByRole("link", {
      name: /Open Experiments/,
    });
    expect(link.getAttribute("href")).toBe("/acme/projects/vm-8/experiments");
    expect(within(blocks8).queryByText("Store")).toBeNull();
  });

  test("Blocks v8 projects open the view without the v7 rollout, listing no v7 tests", async () => {
    state.v8 = new Set(["vm-8"]);
    state.projects = [
      { id: "vm-7", title: "Store", site: "store" },
      { id: "vm-8", title: "Blocks store", site: "blocks" },
    ];
    await renderView(<ExperimentsView scopeId={null} />);
    expect(
      await body().findByTestId("monitor-blocks8-experiments"),
    ).toBeTruthy();
    expect(body().queryByTestId("v7-row")).toBeNull();
    expect(body().queryByTestId("locked")).toBeNull();
  });

  test("with neither, it stays locked", async () => {
    state.projects = [{ id: "vm-7", title: "Store", site: "store" }];
    await renderView(<ExperimentsView scopeId={null} />);
    expect(await body().findByTestId("locked")).toBeTruthy();
  });
});
