import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, within } from "@testing-library/react";
import { SiteDraftViewHeader } from "./view-header";

describe("SiteDraftViewHeader", () => {
  test("a list: the view's name, its actions on the right", () => {
    const view = render(
      <SiteDraftViewHeader
        title="Calendar"
        actions={<button type="button">New campaign</button>}
      />,
    );
    const body = within(view.container);
    expect(body.getByRole("heading", { name: "Calendar" })).toBeTruthy();
    const actions = view.container.querySelector('[data-slot="view-actions"]');
    expect(actions?.textContent).toBe("New campaign");
  });

  test("a detail: the way back in place of the name", () => {
    const onClick = mock(() => {});
    const view = render(
      <SiteDraftViewHeader
        back={{ label: "All A/B tests", onClick }}
        actions={<button type="button">Delete test</button>}
      />,
    );
    const body = within(view.container);
    expect(body.queryByRole("heading")).toBeNull();
    fireEvent.click(body.getByRole("button", { name: "All A/B tests" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

/**
 * The draft bar (environment, Review & Publish) is the same on the site
 * editor, Experiments and Calendar. A view's own actions sit in its header
 * row, never portaled into the bar, so Publish never moves.
 */
describe("Experiments and Calendar keep their actions in the view", () => {
  const src = join(import.meta.dir, "../..");
  const views = [
    "layouts/main-panel-tabs/experiments-block-tab.tsx",
    "components/sandbox/content/campaigns/campaigns-view.tsx",
  ];
  for (const file of views) {
    test(`${file} puts its actions in SiteDraftViewHeader`, () => {
      const source = readFileSync(join(src, file), "utf8");
      expect(source).not.toContain("<Page.Actions");
      expect(source).not.toContain("Topbar.Right.Portal");
      expect(source).not.toMatch(/<Page\.Title[^>]*actions=/);
      // The list and the detail of each view.
      expect(source.match(/<SiteDraftViewHeader/g)?.length).toBe(2);
    });
  }

  test("the Calendar view is headed Calendar, as its row and breadcrumb", () => {
    const source = readFileSync(
      join(src, "layouts/main-panel-tabs/calendar-tab.tsx"),
      "utf8",
    );
    expect(source).toContain('title={t("common.mainPanelTabs.calendar")}');
  });
});
