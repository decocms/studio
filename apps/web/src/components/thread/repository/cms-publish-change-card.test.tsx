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
  test("a page that uses a test or campaign that no longer exists says so, and can still be published or discarded", () => {
    const body = renderCard(promo(["experiments", "campaigns"]));
    const note = body.getByTestId("publish-change-missing-rule");
    expect(note.textContent).toBe(
      "Uses a test that no longer existsUses a campaign that no longer exists",
    );
    expect(body.getByRole("button", { name: "Discard" })).not.toBeDisabled();
  });

  test("says nothing when every test and campaign exists", () => {
    const body = renderCard(promo());
    expect(body.queryByTestId("publish-change-missing-rule")).toBeNull();
  });

  test("the A/B tests card says how many pages still use a test it no longer has", () => {
    const tests = (count: number): PublishChange => ({
      ...promo(),
      kind: "block",
      blockKey: "experiments",
      name: "A/B tests",
      missingRuleUses: { kind: "experiments", count },
    });
    expect(
      renderCard(tests(2)).getByTestId("publish-change-missing-rule-uses")
        .textContent,
    ).toBe("2 pages still use tests that no longer exist");
    cleanup();
    expect(
      renderCard(tests(1)).getByTestId("publish-change-missing-rule-uses")
        .textContent,
    ).toBe("1 page still uses a test that no longer exists");
  });

  test("speaks pt-br too", () => {
    expect(ptBR["thread.publishPopover.missingTest"]).toBe(
      "Usa um teste que não existe mais",
    );
    expect(ptBR["thread.publishPopover.missingCampaign"]).toBe(
      "Usa uma campanha que não existe mais",
    );
    expect(ptBR["thread.publishPopover.missingTestUses"]).toBe(
      "{count} páginas ainda usam testes que não existem mais",
    );
  });
});
