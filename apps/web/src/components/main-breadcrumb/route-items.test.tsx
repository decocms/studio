import { describe, expect, test } from "bun:test";
import { AgentAvatar } from "@/components/agent-icon";
import { projectMainBreadcrumbItem } from "./route-items";

describe("projectMainBreadcrumbItem", () => {
  test("uses the project avatar as the root control and links project Home", () => {
    const item = projectMainBreadcrumbItem(
      "acme",
      {
        id: "vir_store",
        title: "Storefront",
        icon: "https://example.test/icon.png",
      },
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
    expect(item.icon).toMatchObject({ type: AgentAvatar });
  });
});
