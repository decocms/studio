import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, it } from "bun:test";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { Main } from "@/components/main";
import { MainBreadcrumb } from ".";

function renderBreadcrumb(currentId: string) {
  const rootRoute = createRootRoute({
    component: () => (
      <Main>
        <MainBreadcrumb
          scope={{
            id: "organization:1",
            label: "Home",
            icon: <svg data-testid="home-icon" />,
            link: { to: "/" },
          }}
          current={{ id: currentId, label: "Home" }}
        />
      </Main>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const queryClient = new QueryClient();

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("MainBreadcrumb", () => {
  it("omits a current Home scope from the parent breadcrumb", async () => {
    const { container, findByRole, getByTestId, queryByRole } =
      renderBreadcrumb("organization:1");

    const heading = await findByRole("heading", { level: 1, name: "Home" });
    expect(heading).toContainElement(getByTestId("home-icon"));
    expect(queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(
      container.querySelector(
        '[data-slot="main-breadcrumb-current-separator"]',
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps the title separator for a distinct current destination", async () => {
    const { container, findByRole } = renderBreadcrumb("route:tasks");

    expect(
      await findByRole("navigation", { name: "Breadcrumb" }),
    ).toBeInTheDocument();
    expect(await findByRole("link", { name: "Home" })).toBeInTheDocument();
    expect(
      await findByRole("heading", { level: 1, name: "Home" }),
    ).toBeInTheDocument();
    expect(
      container.querySelector(
        '[data-slot="main-breadcrumb-current-separator"]',
      ),
    ).toBeInTheDocument();
  });
});
