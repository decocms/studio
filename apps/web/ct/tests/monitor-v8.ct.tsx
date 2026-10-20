import { expect, test } from "@playwright/experimental-ct-react";
import type { Page } from "@playwright/test";
import { MonitorV8 } from "../../src/layouts/main-panel-tabs/monitor-v8-tab.tsx";
import {
  fixtureErrors,
  fixtureReleases,
  fixtureRoutes,
  fixtureSummary,
  fixtureTimeline,
  fixtureUpstreams,
  fixtureWindow,
} from "../harness/monitor-v8-fixtures.ts";

/**
 * The v8 Monitor against stubbed answers of its one endpoint
 * (`/api/:org/monitor/:site/site/data`). The endpoint's SQL and transforms
 * are covered by `monitor-site.test.ts` and checked against the warehouse;
 * this covers what the page does with each answer.
 */

const BASE = "/api/acme/monitor/demo";

type Answers = Partial<Record<string, unknown>>;

async function serve(page: Page, answers: (view: string) => unknown) {
  await page.route(`**${BASE}/site/data?**`, (route) => {
    const url = new URL(route.request().url());
    const view = url.searchParams.get("view") ?? "";
    return route.fulfill({ json: answers(view) });
  });
}

function healthy(): (view: string) => unknown {
  const now = Date.now();
  const window = fixtureWindow(now);
  const data: Answers = {
    summary: fixtureSummary,
    timeline: fixtureTimeline(window),
    routes: fixtureRoutes,
    upstreams: fixtureUpstreams,
    errors: fixtureErrors(now),
    releases: fixtureReleases(window),
  };
  return (view) => ({
    available: true,
    view,
    range: "24h",
    window,
    data: data[view],
  });
}

test("shows the site's requests, latency, cache and slowest pages", async ({
  mount,
  page,
}) => {
  await serve(page, healthy());
  const c = await mount(<MonitorV8 base={BASE} site="demo" />);

  await expect(c.getByText("48.2K")).toBeVisible();
  await expect(c.getByText("0.4%").first()).toBeVisible();
  await expect(c.getByText("312 ms")).toBeVisible();
  await expect(c.getByText("p50 84 ms")).toBeVisible();
  await expect(c.getByText("71%")).toBeVisible();
  await expect(c.getByText("Requests by status")).toBeVisible();
  // Slowest first.
  const routes = c.locator("table tbody tr td:first-child");
  await expect(routes.first()).toHaveText("/products/:slug");
  await expect(c.getByText("Release 4b59af4")).toBeVisible();
});

test("lists upstream calls and sampled errors in their tabs", async ({
  mount,
  page,
}) => {
  await serve(page, healthy());
  const c = await mount(<MonitorV8 base={BASE} site="demo" />);

  await c.getByRole("tab", { name: "Upstreams" }).click();
  await expect(c.getByText("listing")).toBeVisible();
  await expect(c.getByText("63%")).toBeVisible();

  await c.getByRole("tab", { name: "Errors" }).click();
  await expect(
    c.getByText("shopify cart failed: Network connection lost."),
  ).toBeVisible();
  await expect(c.getByText("12×")).toBeVisible();
});

test("asks for the right range", async ({ mount, page }) => {
  const asked: string[] = [];
  await page.route(`**${BASE}/site/data?**`, (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("range") ?? "");
    return route.fulfill({
      json: { available: true, data: null, reason: "no_requests" },
    });
  });
  const c = await mount(<MonitorV8 base={BASE} site="demo" />);
  await expect(c.getByText("No requests in this range")).toBeVisible();
  expect(asked).toContain("24h");
  await c.getByRole("tab", { name: "7 days" }).click();
  await expect.poll(() => asked.includes("7d")).toBe(true);
});

test("explains missing request metrics and points to what already works", async ({
  mount,
  page,
}) => {
  await serve(page, (view) =>
    ["summary", "timeline", "routes"].includes(view)
      ? { available: true, view, data: null, reason: "server_metric_missing" }
      : {
          available: true,
          view,
          data: view === "upstreams" ? fixtureUpstreams : [],
        },
  );
  const c = await mount(<MonitorV8 base={BASE} site="demo" />);

  await expect(c.getByText("Request metrics are on their way")).toBeVisible();
  await expect(
    c.getByText(
      "Request metrics appear once the site runs @decocms/tanstack 8.5 or later. Upstream calls and errors are already shown.",
    ),
  ).toBeVisible();
  await c.getByRole("button", { name: "See upstream calls" }).click();
  await expect(c.getByText("listing")).toBeVisible();
});

test("says calmly when there's no data yet, or nothing went wrong", async ({
  mount,
  page,
}) => {
  await serve(page, (view) =>
    ["summary", "timeline", "routes"].includes(view)
      ? { available: true, view, data: null, reason: "no_telemetry" }
      : { available: true, view, data: [] },
  );
  const c = await mount(<MonitorV8 base={BASE} site="demo" />);
  await expect(c.getByText("Waiting for this site's first data")).toBeVisible();
  await c.getByRole("tab", { name: "Errors" }).click();
  await expect(c.getByText("No errors in this range")).toBeVisible();
});

test("offers a retry when the warehouse doesn't answer", async ({
  mount,
  page,
}) => {
  let fail = true;
  await page.route(`**${BASE}/site/data?**`, (route) =>
    fail
      ? route.fulfill({
          status: 502,
          json: { error: "Failed to query monitor warehouse" },
        })
      : route.fulfill({
          json: healthy()(
            new URL(route.request().url()).searchParams.get("view") ?? "",
          ),
        }),
  );
  const c = await mount(<MonitorV8 base={BASE} site="demo" />);
  await expect(c.getByText("Monitor couldn't load right now")).toBeVisible();
  fail = false;
  await c.getByRole("button", { name: "Try again" }).click();
  await expect(c.getByText("48.2K")).toBeVisible();
});
