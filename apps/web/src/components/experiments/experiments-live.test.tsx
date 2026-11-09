import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ExperimentsLive, type ExperimentsLiveProps } from "./experiments-live";

/** `screen` binds to the document at import; this reads it when called. */
const body = () => within(document.body);

const tests = (values: Record<string, number>) => ({
  experiments: { __resolveType: "split-traffic", ...values },
});

/** Renders `ui` as the page at `url`, so its links resolve their hrefs. */
async function renderAt(ui: ReactNode, url = "/acme/projects/vm-1/monitoring") {
  const rootRoute = createRootRoute({ component: () => <>{ui}</> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  await router.load();
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function live(props: Partial<ExperimentsLiveProps> = {}) {
  return (
    <ExperimentsLive
      orgSlug="acme"
      virtualMcpId="vm-1"
      published={tests({ hero: 40, menu: 0 })}
      draft={tests({ hero: 40, menu: 0 })}
      mode="full"
      openName={null}
      onOpen={() => {}}
      {...props}
    />
  );
}

/** Nothing that writes: create, save, share, turn off, everyone, delete. */
function expectNoEditControls() {
  for (const label of [
    "New A/B test",
    "Save",
    "Turn off",
    "Show to everyone",
    "Delete test",
  ]) {
    expect(body().queryByText(label)).toBeNull();
  }
  expect(body().queryByRole("slider")).toBeNull();
  expect(body().queryByRole("textbox")).toBeNull();
  expect(document.querySelector("input")).toBeNull();
}

describe("the live tests, in full (Monitor)", () => {
  test("lists the published tests with no edit controls", async () => {
    await renderAt(live());
    const rows = await body().findAllByTestId("experiment-live-row");
    expect(
      rows.map((row) => within(row).getByRole("button").textContent),
    ).toEqual(["hero", "menu"]);
    expect(within(rows[0]!).getByText("40% of visitors")).toBeTruthy();
    expect(rows[0]!.querySelector("[data-status=running]")).toBeTruthy();
    expect(rows[1]!.querySelector("[data-status=off]")).toBeTruthy();
    expectNoEditControls();
  });

  test("reads the published tests, not the draft's", async () => {
    await renderAt(
      live({
        published: tests({ hero: 40 }),
        draft: tests({ hero: 90, draftOnly: 10 }),
      }),
    );
    const rows = await body().findAllByTestId("experiment-live-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("40% of visitors")).toBeTruthy();
  });

  test("links the header and each test to the Experiments app", async () => {
    await renderAt(live());
    const edit = await body().findByTestId("experiments-live-edit");
    expect(edit.getAttribute("href")).toBe("/acme/projects/vm-1/experiments");
    const rowEdits = body().getAllByTestId("experiment-live-row-edit");
    expect(rowEdits[0]!.getAttribute("href")).toBe(
      "/acme/projects/vm-1/experiments?test=hero",
    );
  });

  test("the links keep the open thread, so the app opens on the same draft", async () => {
    await renderAt(live(), "/acme/projects/vm-1/monitoring?thread=t-1&view=x");
    const rowEdits = await body().findAllByTestId("experiment-live-row-edit");
    expect(rowEdits[0]!.getAttribute("href")).toBe(
      "/acme/projects/vm-1/experiments?thread=t-1&test=hero",
    );
  });

  test("says when the draft has changes not published yet", async () => {
    await renderAt(live({ draft: tests({ hero: 50, menu: 0 }) }));
    const note = await body().findByTestId("experiments-live-unpublished");
    expect(note.textContent).toContain("aren't published yet");
    expect(within(note).getByRole("link").getAttribute("href")).toBe(
      "/acme/projects/vm-1/experiments",
    );
  });

  test("says nothing when the draft matches what is published", async () => {
    await renderAt(live());
    await body().findAllByTestId("experiment-live-row");
    expect(body().queryByTestId("experiments-live-unpublished")).toBeNull();
  });

  test("a row opens the test", async () => {
    const onOpen = mock((_name: string | null) => {});
    await renderAt(live({ onOpen }));
    fireEvent.click(await body().findByRole("button", { name: "menu" }));
    expect(onOpen).toHaveBeenCalledWith("menu");
  });

  test("the open name shows that test, read-only, with its edit link", async () => {
    const onOpen = mock((_name: string | null) => {});
    await renderAt(live({ openName: "hero", onOpen }));
    const detail = await body().findByTestId("experiment-live-detail");
    expect(within(detail).getByTestId("share-split-in").textContent).toBe(
      "40%",
    );
    expect(
      body().getByTestId("experiments-live-edit").getAttribute("href"),
    ).toBe("/acme/projects/vm-1/experiments?test=hero");
    expectNoEditControls();
    fireEvent.click(body().getByRole("button", { name: /All A\/B tests/ }));
    expect(onOpen).toHaveBeenCalledWith(null);
  });

  test("an unknown name shows the list", async () => {
    await renderAt(live({ openName: "gone" }));
    expect(await body().findAllByTestId("experiment-live-row")).toHaveLength(2);
    expect(body().queryByTestId("experiment-live-detail")).toBeNull();
  });

  test("no published tests: says so", async () => {
    await renderAt(live({ published: {}, draft: {} }));
    expect(await body().findByText("No A/B tests live")).toBeTruthy();
  });

  test("waits while the published content loads", async () => {
    await renderAt(live({ published: null }));
    expect(await body().findByTestId("experiments-live-loading")).toBeTruthy();
    expect(body().queryByTestId("experiment-live-row")).toBeNull();
  });
});

describe("the live tests, compact (Experiments app)", () => {
  test("links to Monitor and opens a test in the editor", async () => {
    const onOpen = mock((_name: string | null) => {});
    await renderAt(
      live({ mode: "compact", onOpen }),
      "/acme/projects/vm-1/experiments?thread=t-1",
    );
    const monitor = await body().findByTestId("experiments-live-monitor");
    expect(monitor.getAttribute("href")).toBe(
      "/acme/projects/vm-1/monitoring?thread=t-1&view=experiments",
    );
    expect(body().queryByTestId("experiment-live-row-edit")).toBeNull();
    fireEvent.click(body().getByRole("button", { name: "hero" }));
    expect(onOpen).toHaveBeenCalledWith("hero");
    expectNoEditControls();
  });

  test("never opens a detail of its own", async () => {
    await renderAt(live({ mode: "compact", openName: "hero" }));
    expect(await body().findAllByTestId("experiment-live-row")).toHaveLength(2);
    expect(body().queryByTestId("experiment-live-detail")).toBeNull();
  });
});
