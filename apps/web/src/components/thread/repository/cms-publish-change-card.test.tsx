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

  test("a hosted blog record reads as a Post, not a Global section", () => {
    cleanup();
    const body = renderCard({
      ...promo(),
      kind: "block",
      blockKey: "blog-manager/posts/b10900000002",
      name: "Raincoats for wide backs",
      pagePath: null,
      blogKind: "post",
    });
    expect(body.getByText("Raincoats for wide backs")).toBeTruthy();
    expect(body.getByText("Post")).toBeTruthy();
    expect(body.queryByText("Global section")).toBeNull();
    expect(body.queryByText(/blog-manager/)).toBeNull();
  });

  test("says nothing when every test and campaign exists", () => {
    const body = renderCard(promo());
    expect(body.queryByTestId("publish-change-missing-rule")).toBeNull();
  });

  test("speaks pt-br too", () => {
    expect(ptBR["thread.publishPopover.missingTest"]).toBe(
      "Usa um teste que não está nos seus testes A/B",
    );
    expect(ptBR["thread.publishPopover.missingCampaign"]).toBe(
      "Usa uma campanha que não está nas suas campanhas",
    );
  });
});
