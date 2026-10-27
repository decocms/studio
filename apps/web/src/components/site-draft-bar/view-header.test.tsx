import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, within } from "@testing-library/react";
import { SITE_DRAFT_VIEW_INSET, SiteDraftViewHeader } from "./view-header";

describe("SiteDraftViewHeader", () => {
  test("a list: the intro sentence, no title row, its actions on the right", () => {
    const view = render(
      <SiteDraftViewHeader
        intro="Every date on your site is a campaign."
        actions={<button type="button">New campaign</button>}
      />,
    );
    const body = within(view.container);
    // The breadcrumb names the view: the list does not repeat it.
    expect(body.queryByRole("heading")).toBeNull();
    expect(
      body.getByText("Every date on your site is a campaign."),
    ).toBeTruthy();
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

  /**
   * The breadcrumb names the view, so a list opens with its intro sentence
   * in the header row, not a title, and says it once.
   */
  for (const [file, intro] of [
    [
      "layouts/main-panel-tabs/experiments-block-tab.tsx",
      "experiments.v8.intro",
    ],
    [
      "components/sandbox/content/campaigns/campaigns-view.tsx",
      "sandbox.dateCampaigns.intro",
    ],
  ] as const) {
    test(`${file} heads its list with the intro, not a title`, () => {
      const source = readFileSync(join(src, file), "utf8");
      expect(source).not.toMatch(/<SiteDraftViewHeader\s+title=/);
      expect(source).toContain(`intro={t("${intro}")}`);
      expect(source.split(`t("${intro}")`).length - 1).toBe(1);
    });
  }

  /** One side inset for both views, as main's Releases view (16 px). */
  for (const file of views) {
    test(`${file} insets its content as Releases does`, () => {
      const source = readFileSync(join(src, file), "utf8");
      expect(source).not.toContain("<Page.Container");
      expect(source).toContain("SITE_DRAFT_VIEW_INSET");
    });
  }

  test("the inset is Releases' p-4", () => {
    const releases = readFileSync(
      join(src, "layouts/main-panel-tabs/releases-tab.tsx"),
      "utf8",
    );
    expect(SITE_DRAFT_VIEW_INSET).toBe("p-4");
    expect(releases).toMatch(/className="[^"]*\bp-4\b[^"]*"/);
  });
});
