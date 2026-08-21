import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

// Black-box wire-contract shapes (owned by this test, per e2e isolation rules).
interface TaskBoardItem {
  id: string;
  title: string;
  sprint: number | null;
}
interface SprintConfig {
  enabled: boolean;
  weeks: number;
  startDate: string;
}
interface OrgSettings {
  organizationId: string;
  sprint_config: SprintConfig | null;
}

test.describe("task board sprints", () => {
  test("a task's sprint persists through create, update and list", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);

    const { item: planned } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Planned into sprint 2", sprint: 2 },
    );
    expect(planned.sprint).toBe(2);

    // No sprint passed = backlog, which is every existing card's state.
    const { item: backlog } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_CREATE",
      { title: "Backlog task" },
    );
    expect(backlog.sprint).toBe(null);

    const { item: moved } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_UPDATE",
      { id: backlog.id, sprint: 5 },
    );
    expect(moved.sprint).toBe(5);

    // Explicit null moves it back to the backlog; an omitted sprint must not.
    const { item: renamed } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_UPDATE",
      { id: backlog.id, title: "Backlog task, renamed" },
    );
    expect(renamed.sprint).toBe(5);
    const { item: cleared } = await call<{ item: TaskBoardItem }>(
      "TASK_BOARD_ITEM_UPDATE",
      { id: backlog.id, sprint: null },
    );
    expect(cleared.sprint).toBe(null);

    // The board read is what the UI filters on, so assert it carries the column.
    const { items } = await call<{ items: TaskBoardItem[] }>(
      "TASK_BOARD_ITEM_LIST",
      {},
    );
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get(planned.id)?.sprint).toBe(2);
    expect(byId.get(backlog.id)?.sprint).toBe(null);
  });

  test("the sprint cadence round-trips and is replaced whole", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const call = <T>(name: string, args: unknown) =>
      callSelfMcpTool<T>(request, orgSlug, name, args);
    const orgId = await findOrgId(request, orgSlug);

    const before = await call<OrgSettings>("ORGANIZATION_SETTINGS_GET", {});
    expect(before.sprint_config ?? null).toBe(null);

    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      sprint_config: { enabled: true, weeks: 2, startDate: "2026-01-05" },
    });
    const enabled = await call<OrgSettings>("ORGANIZATION_SETTINGS_GET", {});
    expect(enabled.sprint_config).toEqual({
      enabled: true,
      weeks: 2,
      startDate: "2026-01-05",
    });

    // Writing another setting must not disturb the cadence.
    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      flags: { auto_merge: false },
    });
    const untouched = await call<OrgSettings>("ORGANIZATION_SETTINGS_GET", {});
    expect(untouched.sprint_config?.weeks).toBe(2);

    await call("ORGANIZATION_SETTINGS_UPDATE", {
      organizationId: orgId,
      sprint_config: { enabled: false, weeks: 3, startDate: "2026-02-02" },
    });
    const off = await call<OrgSettings>("ORGANIZATION_SETTINGS_GET", {});
    expect(off.sprint_config).toEqual({
      enabled: false,
      weeks: 3,
      startDate: "2026-02-02",
    });
  });
});
