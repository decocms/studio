import { expect, test } from "../fixtures/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";

test("task harness selection is gated, persisted, and available through REST and MCP", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  const api = page.context().request;
  const post = (name: string, data: unknown) =>
    api.post(`/api/${orgSlug}/tools/${name}`, { data });
  const create = (data: unknown) => post("TASK_BOARD_ITEM_CREATE", data);
  for (const harnessId of [null, "", "decopilot", "Codex", "x".repeat(10000)]) {
    expect(
      (await create({ title: "Invalid selection", harnessId })).status(),
    ).toBe(400);
  }
  const legacy = await create({ title: "Default task" });
  expect(legacy.ok()).toBe(true);
  expect((await legacy.json()).item.harnessId).toBe("claude-code");
  expect(
    (await create({ title: "Gated task", harnessId: "codex" })).status(),
  ).toBe(403);
  const org = await callSelfMcpTool<{ id: string }>(
    api,
    orgSlug,
    "ORGANIZATION_GET",
    {},
  );
  const flags = await post("ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: org.id,
    flags: { task_board_codex: true },
  });
  expect(flags.ok()).toBe(true);
  const missing = await create({
    title: "Missing credentials",
    harnessId: "codex",
  });
  expect(missing.ok()).toBe(false);
  const linked = await post("CODEX_SUBSCRIPTION_CONNECT", {
    authJson: JSON.stringify({
      tokens: {
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        id_token: "synthetic-id",
        account_id: "account_example",
      },
    }),
  });
  expect(linked.ok()).toBe(true);
  const created = await create({ title: "Codex task", harnessId: "codex" });
  expect(created.ok()).toBe(true);
  const { item } = await created.json();
  expect(item.harnessId).toBe("codex");
  const updated = await callSelfMcpTool<{ item: { harnessId: string } }>(
    api,
    orgSlug,
    "TASK_BOARD_ITEM_UPDATE",
    { id: item.id, title: "Updated task" },
  );
  expect(updated.item.harnessId).toBe("codex");
  const switched = await post("TASK_BOARD_ITEM_UPDATE", {
    id: item.id,
    harnessId: "claude-code",
  });
  expect(switched.ok()).toBe(true);
  expect((await switched.json()).item.harnessId).toBe("claude-code");
});
