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
const ready = (content: Record<string, unknown>) =>
  ({ state: "ready", content }) as const;

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
      published={ready(tests({ hero: 40, menu: 0 }))}
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
        published: ready(tests({ hero: 40 })),
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
    // Each "Edit" names its test for a screen reader's list of links.
    expect(rowEdits[0]!.getAttribute("aria-label")).toBe(
      "Edit hero in Experiments",
    );
    expect(rowEdits[1]!.getAttribute("aria-label")).toBe(
      "Edit menu in Experiments",
    );
  });

  test("a live test the draft removed links to the app's list, and says so", async () => {
    await renderAt(live({ draft: tests({ hero: 40 }) }));
    const rows = await body().findAllByTestId("experiment-live-row");
    expect(within(rows[1]!).getByText("Removed in your draft")).toBeTruthy();
    expect(
      within(rows[1]!)
        .getByTestId("experiment-live-row-edit")
        .getAttribute("href"),
    ).toBe("/acme/projects/vm-1/experiments");
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
    expect(note.textContent).toContain(
      "Your draft has A/B test changes that aren't published yet.",
    );
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

  test("the detail's note is about that test only", async () => {
    // The draft changes menu, not hero.
    await renderAt(
      live({ openName: "hero", draft: tests({ hero: 40, menu: 50 }) }),
    );
    await body().findByTestId("experiment-live-detail");
    expect(body().queryByTestId("experiments-live-unpublished")).toBeNull();
  });

  test("the detail of a test the draft changes says so", async () => {
    await renderAt(
      live({ openName: "hero", draft: tests({ hero: 70, menu: 0 }) }),
    );
    expect(
      (await body().findByTestId("experiments-live-unpublished")).textContent,
    ).toBe("Your draft changes this test; it isn't published yet.");
  });

  test("the detail of a test the draft removed says so and edits the list", async () => {
    await renderAt(live({ openName: "hero", draft: tests({ menu: 0 }) }));
    expect(
      (await body().findByTestId("experiments-live-unpublished")).textContent,
    ).toBe("Your draft removes this test; it stays live until you publish.");
    expect(
      body().getByTestId("experiments-live-edit").getAttribute("href"),
    ).toBe("/acme/projects/vm-1/experiments");
  });

  test("a name that isn't live shows the list, says so and links to it", async () => {
    await renderAt(
      live({
        openName: "fresh",
        draft: tests({ hero: 40, menu: 0, fresh: 5 }),
      }),
    );
    expect(await body().findAllByTestId("experiment-live-row")).toHaveLength(2);
    expect(body().queryByTestId("experiment-live-detail")).toBeNull();
    const note = body().getByTestId("experiments-live-not-live");
    expect(note.textContent).toContain("“fresh” isn't live yet.");
    expect(within(note).getByRole("link").getAttribute("href")).toBe(
      "/acme/projects/vm-1/experiments?test=fresh",
    );
  });

  test("no published tests: says so", async () => {
    await renderAt(live({ published: ready({}), draft: {} }));
    expect(await body().findByText("No A/B tests live")).toBeTruthy();
  });

  test("waits while the published content loads", async () => {
    await renderAt(live({ published: { state: "loading" } }));
    expect(await body().findByTestId("experiments-live-loading")).toBeTruthy();
    expect(body().queryByTestId("experiment-live-row")).toBeNull();
  });

  test("a failed read says so and can try again", async () => {
    const retry = mock(() => {});
    await renderAt(live({ published: { state: "failed", retry } }));
    expect(await body().findByText("Couldn't load your tests.")).toBeTruthy();
    expect(body().queryByTestId("experiments-live-loading")).toBeNull();
    fireEvent.click(body().getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });

  test("an unreadable published copy is never shown as the draft's", async () => {
    await renderAt(
      live({ published: { state: "unknown" }, draft: tests({ hero: 90 }) }),
    );
    expect(await body().findByText("Couldn't read what's live")).toBeTruthy();
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
    // The row says it opens the editor, not more of what is live.
    fireEvent.click(body().getByRole("button", { name: "Edit hero" }));
    expect(onOpen).toHaveBeenCalledWith("hero");
    expectNoEditControls();
    expect(
      body().getByRole("heading", { level: 2, name: "Live now" }),
    ).toBeTruthy();
  });

  test("a live test the draft removed opens nothing", async () => {
    await renderAt(live({ mode: "compact", draft: tests({ hero: 40 }) }));
    const rows = await body().findAllByTestId("experiment-live-row");
    expect(within(rows[1]!).queryByRole("button")).toBeNull();
    expect(within(rows[1]!).getByText("Removed in your draft")).toBeTruthy();
    expect(body().queryByTestId("experiments-live-unpublished")).toBeNull();
  });

  test("a failed read says so in place, with a retry", async () => {
    const retry = mock(() => {});
    await renderAt(
      live({ mode: "compact", published: { state: "failed", retry } }),
    );
    expect(
      await body().findByTestId("experiments-live-unavailable"),
    ).toBeTruthy();
    fireEvent.click(body().getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });

  test("never opens a detail of its own", async () => {
    await renderAt(live({ mode: "compact", openName: "hero" }));
    expect(await body().findAllByTestId("experiment-live-row")).toHaveLength(2);
    expect(body().queryByTestId("experiment-live-detail")).toBeNull();
  });
});
