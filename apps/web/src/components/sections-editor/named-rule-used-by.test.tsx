import { setupComponentTest } from "../../../test/setup";
setupComponentTest();
import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render as rtlRender, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import { MissingNamedRuleUses, NamedRuleUsedBy } from "./named-rule-used-by";
import type { NamedRuleUseRow } from "./named-rule-uses";

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>,
  );

const rows: NamedRuleUseRow[] = [
  {
    blockKey: "pages-home-1",
    blockKind: "page",
    title: "Home",
    path: "/",
    variant: 1,
    wholeBlock: false,
    state: "published",
  },
  {
    blockKey: "banner",
    blockKind: "section",
    title: "Banner",
    variant: 2,
    wholeBlock: false,
    state: "draft-only",
  },
  {
    blockKey: "pages-old-2",
    blockKind: "page",
    title: "Old page",
    path: "/old",
    wholeBlock: false,
    state: "removed-in-draft",
  },
];

describe("NamedRuleUsedBy", () => {
  test("lists each use with its page, variant and draft marks, and opens it", () => {
    const onOpen = mock((_row: NamedRuleUseRow) => {});
    render(
      <NamedRuleUsedBy
        kind="experiments"
        rows={rows}
        wholeRows={[]}
        marked
        onOpen={onOpen}
      />,
    );
    const items = within(
      within(document.body).getByTestId("named-rule-used-by"),
    ).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-use-state"))).toEqual([
      "published",
      "draft-only",
      "removed-in-draft",
    ]);
    expect(items[0]!.textContent).toContain("/ · Variant 1");
    expect(items[1]!.textContent).toContain("Not published yet");
    expect(items[2]!.textContent).toContain("Removed in your draft");
    // A use the draft removed has nothing to open.
    expect(within(items[2]!).queryByText("Open")).toBeNull();
    fireEvent.click(within(items[1]!).getByText("Open"));
    expect(onOpen).toHaveBeenCalledWith(rows[1]);
  });

  test("shows no marks until the published site is known", () => {
    render(
      <NamedRuleUsedBy
        kind="experiments"
        rows={rows.slice(0, 2)}
        wholeRows={[]}
        marked={false}
      />,
    );
    expect(within(document.body).queryByText("Not published yet")).toBeNull();
  });

  test("guides when nothing uses it, and lists sections that read every name", () => {
    render(
      <NamedRuleUsedBy
        kind="campaigns"
        rows={[]}
        wholeRows={[{ ...rows[1]!, variant: undefined, wholeBlock: true }]}
        marked
      />,
    );
    expect(
      within(document.body).getByText(/give a variant the rule “Date”/),
    ).toBeTruthy();
    expect(
      within(document.body).getByText("Sections that read every campaign"),
    ).toBeTruthy();
    expect(within(document.body).getByText("Banner")).toBeTruthy();
  });
});

describe("MissingNamedRuleUses", () => {
  test("a calm line lists the pages that use a test that no longer exists, each one opening", () => {
    const onOpen = mock((_row: NamedRuleUseRow) => {});
    render(
      <MissingNamedRuleUses
        kind="experiments"
        rows={rows.slice(0, 1)}
        onOpen={onOpen}
      />,
    );
    const section = within(
      within(document.body).getByTestId("named-rule-missing-uses"),
    );
    expect(
      section.getByText("These pages use tests that no longer exist."),
    ).toBeTruthy();
    fireEvent.click(section.getByText("Open"));
    expect(onOpen).toHaveBeenCalledWith(rows[0]);
  });

  test("says campaigns for campaigns, in pt-br too, and nothing when none", () => {
    render(
      <MissingNamedRuleUses kind="campaigns" rows={[]} onOpen={() => {}} />,
    );
    expect(
      within(document.body).queryByTestId("named-rule-missing-uses"),
    ).toBeNull();
    expect(en["sectionsEditor.namedRuleUses.missingCampaigns"]).toBe(
      "These pages use campaigns that no longer exist.",
    );
    expect(ptBR["sectionsEditor.namedRuleUses.missingTests"]).toBe(
      "Estas páginas usam testes que não existem mais.",
    );
    expect(ptBR["sectionsEditor.namedRuleUses.missingCampaigns"]).toBe(
      "Estas páginas usam campanhas que não existem mais.",
    );
  });
});
