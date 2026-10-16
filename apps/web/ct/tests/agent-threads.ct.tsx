import { expect, test } from "@playwright/experimental-ct-react";
import { AgentThreadsHarness } from "../harness/agent-threads-harness";

test("a run's thread shows the run's state", async ({ mount }) => {
  const component = await mount(<AgentThreadsHarness />);

  await expect(component.getByText("Done", { exact: true })).toBeVisible();
  await expect(component.getByText("Running", { exact: true })).toBeVisible();
});

test("the Super Agent is the first pick under @", async ({ mount, page }) => {
  const component = await mount(<AgentThreadsHarness running={false} />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await composer.pressSequentially("@");
  const menu = page.getByTestId("mention-menu");
  await expect(menu.getByRole("option").first()).toHaveText("Super Agent");
});

test("mentioning the Super Agent with no run in progress starts one", async ({
  mount,
  page,
}) => {
  const component = await mount(<AgentThreadsHarness running={false} />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });
  await expect(component.getByTestId("agent-route-note")).toHaveCount(0);

  await composer.pressSequentially("@");
  await page.getByTestId("mention-menu").getByText("Super Agent").click();

  await expect(component.getByTestId("agent-route-note")).toHaveText(
    "Starts a Super Agent run on this card.",
  );
});

test("mentioning the Super Agent while a run works the card goes to that run", async ({
  mount,
  page,
}) => {
  const component = await mount(<AgentThreadsHarness />);
  const composer = component.getByRole("textbox", {
    name: "Leave a comment...",
  });

  await composer.pressSequentially("@");
  await page.getByTestId("mention-menu").getByText("Super Agent").click();

  await expect(component.getByTestId("agent-route-note")).toContainText(
    "run in progress",
  );
});

test("replying to a finished run picks it up again, unless another run is working", async ({
  mount,
}) => {
  const idle = await mount(<AgentThreadsHarness running={false} />);
  await idle.getByRole("button", { name: "Continue this run" }).first().click();
  await expect(idle.getByTestId("agent-route-note")).toHaveText(
    "Picks this run up again, with everything it already did.",
  );
  await idle.unmount();

  const busy = await mount(<AgentThreadsHarness />);
  await busy.getByRole("button", { name: "Reply" }).first().click();
  const reply = busy.getByRole("textbox", {
    name: "Message the Super Agent...",
  });
  await expect(reply).toBeFocused();
  await reply.fill("also check the listing");
  await expect(busy.getByTestId("agent-route-note")).toContainText(
    "Another run is working on this card",
  );
  await expect(
    busy.locator('[data-agent-route="busy"]').getByLabel("Send"),
  ).toBeDisabled();
});
