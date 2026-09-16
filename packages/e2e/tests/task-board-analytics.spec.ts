import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/**
 * Black-box wire-contract shapes, owned by this test per the e2e isolation
 * rules. Two copies of the analytics SQL exist (Grafana and Studio); this suite
 * exists to make a divergence loud rather than to prevent it.
 */
type Section =
  | {
      kind: "stat";
      title: string;
      values: { label: string; value: number | null; unit?: string }[];
    }
  | {
      kind: "series";
      title: string;
      unit?: string;
      points: Record<string, number | string | null>[];
    }
  | {
      kind: "table";
      title: string;
      columns: string[];
      rows: (string | number | null)[][];
    };

interface AnalyticsPayload {
  range: { from: string; to: string };
  org: string;
  sections: Section[];
}

interface AdminOrgList {
  isTaskBoardAdmin: boolean;
  isCrossOrgView: boolean;
  orgs: { id: string; slug: string; name: string }[];
}

const TOOLS = [
  "TASK_BOARD_DELIVERY",
  "TASK_BOARD_STUCK",
  "TASK_BOARD_COST",
  "TASK_BOARD_QUALITY",
  "TASK_BOARD_ERRORS",
  "TASK_BOARD_TENANTS",
] as const;

/** Every count, percentage and duration the dashboards report is non-negative. */
function expectNonNegative(sections: Section[]) {
  for (const section of sections) {
    if (section.kind === "stat") {
      for (const v of section.values) {
        if (v.value !== null) expect(v.value).toBeGreaterThanOrEqual(0);
      }
    }
    if (section.kind === "series") {
      for (const point of section.points) {
        expect(typeof point.t).toBe("string");
        for (const [key, value] of Object.entries(point)) {
          if (key === "t") continue;
          if (typeof value === "number")
            expect(value).toBeGreaterThanOrEqual(0);
        }
      }
    }
    if (section.kind === "table") {
      for (const row of section.rows) {
        expect(row).toHaveLength(section.columns.length);
      }
    }
  }
}

test.describe("task board analytics", () => {
  test("every tool answers with the shared envelope, scoped to this org", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    // Without a status_changed row the `moves` CTE is empty and this proves nothing.
    const { item } = await call<{ item: { id: string } }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Analytics fixture" },
    );
    await call("TASK_BOARD_ITEM_UPDATE", {
      id: item.id,
      status: "in_progress",
    });
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, status: "in_review" });
    await call("TASK_BOARD_ITEM_UPDATE", { id: item.id, status: "done" });

    for (const tool of TOOLS) {
      const payload = await call<AnalyticsPayload>(tool, {});
      expect(payload.org, `${tool} scopes to the caller's org`).toBe(orgSlug);
      expect(Date.parse(payload.range.from)).toBeLessThan(
        Date.parse(payload.range.to),
      );
      expect(
        payload.sections.length,
        `${tool} returns sections`,
      ).toBeGreaterThan(0);
      for (const section of payload.sections) {
        expect(["stat", "series", "table"]).toContain(section.kind);
        expect(section.title).toBeTruthy();
      }
      expectNonNegative(payload.sections);
    }

    const delivery = await call<AnalyticsPayload>("TASK_BOARD_DELIVERY", {});
    const throughput = delivery.sections.find((s) => s.kind === "stat");
    expect(throughput).toBeDefined();
    const completed = (
      throughput as Extract<Section, { kind: "stat" }>
    ).values.find((v) => v.label === "Tasks completed")?.value;
    expect(completed).toBeGreaterThanOrEqual(1);
  });

  test("a normal member gets no cross-org reach", async ({ authedPage }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const admin = await call<AdminOrgList>("TASK_BOARD_ADMIN_ORG_LIST", {});
    expect(admin.isTaskBoardAdmin).toBe(false);
    expect(admin.isCrossOrgView).toBe(false);
    expect(admin.orgs).toEqual([]);

    // "all" is a widening request, not a different question — it narrows back.
    const all = await call<AnalyticsPayload>("TASK_BOARD_DELIVERY", {
      org: "all",
    });
    expect(all.org).toBe(orgSlug);

    await expect(
      call("TASK_BOARD_DELIVERY", { org: "some-other-org" }),
    ).rejects.toThrow(/Not allowed/);
  });
});
