import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { afterAll, describe, expect, test } from "bun:test";
import { mock } from "bun:test";
import { act, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as realBlockTab from "./experiments-block-tab";
import type { ExperimentsBlockTabProps } from "./experiments-block-tab";

const tests = (values: Record<string, number>) => ({
  experiments: { __resolveType: "split-traffic", ...values },
});

/** What the app handed the CRUD tab, last render. */
let last: ExperimentsBlockTabProps | null = null;
const openedInEditor: string[] = [];

const restore = { ...realBlockTab };
afterAll(() => {
  mock.module("./experiments-block-tab", () => restore);
});
// The CRUD tab itself is covered by experiments-block-tab.test.tsx: here it
// renders its slot as the list does, with a draft that changed a share.
mock.module("./experiments-block-tab", () => ({
  ...restore,
  ExperimentsBlockTab: (props: ExperimentsBlockTabProps) => {
    last = props;
    return (
      <div data-testid="crud-tab" data-open={props.open?.name ?? ""}>
        {props.live?.({
          orgSlug: "acme",
          virtualMcpId: props.virtualMcpId,
          draft: tests({ hero: 60 }),
          published: tests({ hero: 40 }),
          openTest: (name) => openedInEditor.push(name),
        })}
      </div>
    );
  },
}));

const { ExperimentsApp } = await import("./experiments-app");

async function renderApp(url: string) {
  const rootRoute = createRootRoute({
    component: () => <ExperimentsApp virtualMcpId="vm-1" />,
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, body: within(view.container) };
}

describe("the Experiments app", () => {
  test("?test= opens that test in the editor", async () => {
    const { body } = await renderApp(
      "/acme/projects/vm-1/experiments?test=hero",
    );
    const tab = await body.findByTestId("crud-tab");
    expect(tab.getAttribute("data-open")).toBe("hero");
  });

  test("opening and closing a test writes ?test=", async () => {
    const { router, body } = await renderApp("/acme/projects/vm-1/experiments");
    await body.findByTestId("crud-tab");
    await act(async () => last?.open?.set("menu"));
    expect(router.state.location.search).toMatchObject({ test: "menu" });
    expect(
      (await body.findByTestId("crud-tab")).getAttribute("data-open"),
    ).toBe("menu");
    await act(async () => last?.open?.set(null));
    expect(router.state.location.search).not.toHaveProperty("test");
  });

  test("shows what is live under the tests, read-only, with the way to Monitor", async () => {
    const { body } = await renderApp(
      "/acme/projects/vm-1/experiments?thread=t-1",
    );
    const live = await body.findByTestId("experiments-live-compact");
    const rows = within(live).getAllByTestId("experiment-live-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("40% of visitors")).toBeTruthy();
    expect(
      within(live).getByTestId("experiments-live-unpublished"),
    ).toBeTruthy();
    expect(
      within(live).getByTestId("experiments-live-monitor").getAttribute("href"),
    ).toBe("/acme/projects/vm-1/monitoring?thread=t-1&view=experiments");
    expect(within(live).queryByRole("slider")).toBeNull();
    act(() => within(rows[0]!).getByRole("button", { name: "hero" }).click());
    expect(openedInEditor).toEqual(["hero"]);
  });
});
