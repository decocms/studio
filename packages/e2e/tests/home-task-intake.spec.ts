import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

test.setTimeout(120_000);

async function enableTaskIntake(
  api: Parameters<typeof findOrgId>[0],
  orgSlug: string,
) {
  const orgId = await findOrgId(api, orgSlug);
  await callSelfMcpTool(api, orgSlug, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId: orgId,
    flags: { home_task_intake_enabled: true },
  });
}

test("Task mode is Home's default and the report survives toggling it off", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  await enableTaskIntake(page.context().request, orgSlug);
  await page.goto(`/${orgSlug}/home?sidepanel=false`);

  const input = page.locator('[data-chat-input="true"]');
  await expect(input).toBeVisible({ timeout: 90_000 });
  const task = page.getByRole("button", { name: "Task", exact: true });
  await expect(task).toHaveAttribute("aria-pressed", "true");
  await expect(
    page.getByRole("button", { name: "Start task", exact: true }),
  ).toBeVisible();

  const report = "The command palette does not filter results when I type.";
  await input.fill(report);
  await task.click();
  await expect(task).toHaveAttribute("aria-pressed", "false");
  await expect(input).toHaveText(report);
  await page.reload();
  await expect(task).toHaveAttribute("aria-pressed", "false");
  await expect(input).toHaveText(report);
});

test("Start task sends the report and the start-task guide in one message", async ({
  authedPage,
}) => {
  const { page, orgSlug } = authedPage;
  await enableTaskIntake(page.context().request, orgSlug);
  await page.goto(`/${orgSlug}/home?sidepanel=false`);

  const input = page.locator('[data-chat-input="true"]');
  await expect(input).toBeVisible({ timeout: 90_000 });
  const report = "Please fix keyboard navigation in the report app.";
  await input.fill(report);

  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/messages"),
    { timeout: 60_000 },
  );
  await page.getByRole("button", { name: "Start task", exact: true }).click();

  // The wire payload is the contract: the user's words, verbatim, behind the
  // guide that tells the agent to find a repo and delegate.
  const payload = JSON.stringify((await sent).postDataJSON());
  expect(payload).toContain(report);
  expect(payload).toContain("REPOSITORY_LIST");
  expect(payload).toContain("TASK_BOARD_ITEM_CREATE");
  expect(payload).toContain("super-agent");
});
