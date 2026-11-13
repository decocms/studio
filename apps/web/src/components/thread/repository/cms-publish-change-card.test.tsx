import { setupComponentTest } from "../../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { cleanup, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PublishChangeCard } from "./cms-publish-change-card";
import type { PublishChange } from "./publish-change-summary";

const promo = (): PublishChange => ({
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
});
