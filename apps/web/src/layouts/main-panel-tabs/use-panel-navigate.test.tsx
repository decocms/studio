import { setupComponentTest } from "../../../test/setup";

setupComponentTest();

import { act, render } from "@testing-library/react";
import { describe, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { useMatchedMainView } from "./use-panel-navigate";

describe("useMatchedMainView", () => {
  test("does not rerender for unrelated router-state changes", async () => {
    const rootRoute = createRootRoute();
    const viewRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      staticData: { mainView: "settings" },
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([viewRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    await router.load();

    let renders = 0;
    function Probe() {
      const selection = useMatchedMainView();
      renders++;
      return <output>{selection.mainView}</output>;
    }

    const view = render(
      <RouterContextProvider router={router}>
        <Probe />
      </RouterContextProvider>,
    );
    expect(view.getByText("settings")).toBeInTheDocument();
    expect(renders).toBe(1);

    act(() => {
      router.stores.loadedAt.set((loadedAt) => loadedAt + 1);
    });

    expect(renders).toBe(1);
  });
});
