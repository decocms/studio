import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

test("re-running a card the Super Agent doesn't have is a 409 naming the assignee id", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;

  const list = await api.get(`/api/${orgSlug}/tools`);
  expect(list.ok()).toBe(true);
  const { tools } = (await list.json()) as {
    tools: {
      name: string;
      inputSchema?: {
        properties?: Record<string, { description?: string }>;
      };
    }[];
  };
  for (const name of ["TASK_BOARD_ITEM_CREATE", "TASK_BOARD_ITEM_UPDATE"]) {
    const tool = tools.find((t) => t.name === name);
    expect(tool?.inputSchema?.properties?.assigneeId?.description).toContain(
      `"${SUPER_AGENT_ASSIGNEE_ID}"`,
    );
  }

  const created = await api.post(
    `/api/${orgSlug}/tools/TASK_BOARD_ITEM_CREATE`,
    {
      data: { title: "Unassigned task" },
    },
  );
  expect(created.ok()).toBe(true);
  const { item } = (await created.json()) as { item: { id: string } };

  const rerun = await api.post(`/api/${orgSlug}/tools/TASK_BOARD_ITEM_RERUN`, {
    data: { id: item.id },
  });
  expect(rerun.status()).toBe(409);
  const body = (await rerun.json()) as { error: string };
  expect(body.error).toContain(`assigneeId "${SUPER_AGENT_ASSIGNEE_ID}"`);

  await expect(
    callSelfMcpTool(api, orgSlug, "TASK_BOARD_ITEM_RERUN", { id: item.id }),
  ).rejects.toThrow(`assigneeId "${SUPER_AGENT_ASSIGNEE_ID}"`);
});
