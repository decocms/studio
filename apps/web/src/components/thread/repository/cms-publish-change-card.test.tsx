import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ptBR } from "@/i18n/pt-br/index.ts";
import { PublishChangeCard } from "./cms-publish-change-card";
import type { PublishChange } from "./publish-change-summary";

const promo = (
  missingRules?: PublishChange["missingRules"],
): PublishChange => ({
  kind: "page",
  blockKey: "pages-promo",
  name: "Promo",
  pagePath: "/promo",
  isSiteApp: false,
  status: "edited",
  filepaths: [],
  sections: [],
  fromJson: null,
  toJson: null,
  ...(missingRules ? { missingRules } : {}),
});

function renderCard(change: PublishChange) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PublishChangeCard
        change={change}
        selected={false}
        onSelect={() => {}}
        confirming={false}
        onConfirmingChange={() => {}}
        onDiscard={() => {}}
        isPublishing={false}
        isDiscarding={false}
      />
    </QueryClientProvider>,
  );
  return within(document.body);
}

describe("PublishChangeCard", () => {
  test("a page that uses a test or campaign that isn't there says so, and can still be published or discarded", () => {
    const body = renderCard(promo(["experiments", "campaigns"]));
    const note = body.getByTestId("publish-change-missing-rule");
    expect(note.textContent).toBe(
      "Uses a test that isn't in your A/B testsUses a campaign that isn't in your campaigns",
    );
    expect(body.getByRole("button", { name: "Discard" })).not.toBeDisabled();
  });

  test("says nothing when every test and campaign exists", () => {
    const body = renderCard(promo());
    expect(body.queryByTestId("publish-change-missing-rule")).toBeNull();
  });

  test("the A/B tests card counts pages and sections apart", () => {
    const tests = (pages: number, sections: number): PublishChange => ({
      ...promo(),
      kind: "block",
      blockKey: "experiments",
      name: "A/B tests",
      missingRuleUses: { kind: "experiments", pages, sections },
    });
    const line = (pages: number, sections: number) => {
      cleanup();
      return renderCard(tests(pages, sections)).getByTestId(
        "publish-change-missing-rule-uses",
      ).textContent;
    };
    expect(line(2, 0)).toBe("2 pages use tests that aren't in your A/B tests");
    expect(line(1, 0)).toBe("1 page uses a test that isn't in your A/B tests");
    expect(line(0, 1)).toBe(
      "1 section uses a test that isn't in your A/B tests",
    );
    expect(line(2, 1)).toBe(
      "2 pages and 1 section use tests that aren't in your A/B tests",
    );
  });

  test("speaks pt-br too", () => {
    expect(ptBR["thread.publishPopover.missingTest"]).toBe(
      "Usa um teste que não está nos seus testes A/B",
    );
    expect(ptBR["thread.publishPopover.missingCampaign"]).toBe(
      "Usa uma campanha que não está nas suas campanhas",
    );
    expect(ptBR["thread.publishPopover.missingTestUses"]).toBe(
      "{places} usam testes que não estão nos seus testes A/B",
    );
    expect(ptBR["sectionsEditor.namedRuleUses.countBoth"]).toBe(
      "{pages} e {sections}",
    );
  });
});
