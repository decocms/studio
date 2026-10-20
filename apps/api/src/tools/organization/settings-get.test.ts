import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_SETTINGS_GET } from "./settings-get";

describe("ORGANIZATION_SETTINGS_GET", () => {
  it("accepts coding_agent_mcp_excluded on output — regression: it was settable via ORGANIZATION_SETTINGS_UPDATE but missing from this tool's outputSchema", async () => {
    const ctx = {
      auth: { user: { id: "user-1" } },
      organization: { id: "org-a" },
      access: { check: mock(async () => {}) },
      storage: {
        organizationSettings: {
          get: mock(async (organizationId: string) => ({
            organizationId,
            coding_agent_mcp_excluded: ["conn-1", "conn-2"],
            createdAt: new Date("2026-01-01T00:00:00Z"),
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          })),
        },
      },
    } as unknown as Parameters<typeof ORGANIZATION_SETTINGS_GET.handler>[1];

    const result = await ORGANIZATION_SETTINGS_GET.handler({}, ctx);

    // A field absent from outputSchema is silently stripped by .parse().
    const parsed = ORGANIZATION_SETTINGS_GET.outputSchema.parse(result);
    expect(parsed.coding_agent_mcp_excluded).toEqual(["conn-1", "conn-2"]);
  });
});
