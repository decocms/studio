import { describe, expect, it } from "bun:test";
import { legacyWorkspaceCompatibilitySearchSchema } from "./legacy-workspace-search";

describe("legacyWorkspaceCompatibilitySearchSchema", () => {
  it("keeps every destination-owned payload through a compatibility hop", () => {
    const search = {
      file: "src/app.tsx",
      key: "org-fs:outputs/thread/report.pdf",
      deck: "decks/quarterly.html",
      path: "skills/catalog",
      connection: "conn_orders",
      tool: "get_orders",
      automation: "automation_1",
      preview: "skills/catalog/readme.md",
      autosend: "1",
      connect: 1,
      siteUrl: "https://store.example",
      contentPageId: "page-product",
      contentPath: "/products/blue",
      contentPathTemplate: "/products/:slug",
      task: "task_1",
      view: "list",
      q: "checkout",
      assignee: "user_1",
      priority: "high",
      due: "week",
      tags: "storefront,urgent",
      repo: "acme/storefront",
      skill: "checkout-audit",
      brand: "acme",
    };

    expect(legacyWorkspaceCompatibilitySearchSchema.parse(search)).toEqual({
      ...search,
      connect: "1",
    });
  });
});
