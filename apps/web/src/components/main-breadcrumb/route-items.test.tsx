import { describe, expect, test } from "bun:test";
import { Home02 } from "@untitledui/icons";
import { projectMainBreadcrumbItem } from "./route-items";

describe("projectMainBreadcrumbItem", () => {
  test("uses a Home control, not the project avatar, and links project Home", () => {
    const item = projectMainBreadcrumbItem(
      "acme",
      { id: "vir_store", title: "Storefront" },
      "Project",
    );

    expect(item).toMatchObject({
      id: "project:vir_store",
      label: "Storefront",
      link: {
        to: "/$org/projects/$agentId",
        params: { org: "acme", agentId: "vir_store" },
      },
    });
    expect(item.icon).toMatchObject({ type: Home02 });
  });

  test("falls back to the supplied label when the project has a blank title", () => {
    const item = projectMainBreadcrumbItem(
      "acme",
      { id: "vir_store", title: "   " },
      "Project",
    );

    expect(item.label).toBe("Project");
  });
});
