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
    "Starts a new Super Agent run.",
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
    "after its current step",
  );
});

test("replying to a finished run picks it up again, unless another run is working", async ({
  mount,
}) => {
  const idle = await mount(<AgentThreadsHarness running={false} />);
  await idle.getByTitle("Continue this run").first().click();
  await expect(idle.getByTestId("agent-route-note")).toHaveText(
    "Picks this run up where it stopped.",
  );
  await idle.unmount();

  const busy = await mount(<AgentThreadsHarness />);
  await busy
    .getByRole("button", { name: "Reply", exact: true })
    .first()
    .click();
  const reply = busy.getByRole("textbox", {
    name: "Message the Super Agent...",
  });
  await expect(reply).toBeFocused();
  await reply.fill("also check the listing");
  await expect(busy.getByTestId("agent-route-note")).toContainText(
    "Another run is already working on this card",
  );
  await expect(
    busy.locator('[data-agent-route="busy"]').getByLabel("Send"),
  ).toBeDisabled();
});

test("a finished run's thread opens folded, and unfolds on demand", async ({
  mount,
}) => {
  const component = await mount(<AgentThreadsHarness />);
  const finished = component.getByTestId("comment-thread").first();
  const running = component.getByTestId("comment-thread").last();

  await expect(finished).toHaveAttribute("data-expanded", "false");
  await expect(running).toHaveAttribute("data-expanded", "true");
  await expect(finished.getByText(/^Done\. The promotional/)).toHaveCount(0);

  await finished.getByRole("button", { name: /1 reply/ }).click();
  await expect(finished.getByText(/^Done\. The promotional/)).toBeVisible();
  await finished.getByRole("button", { name: "Hide replies" }).click();
  await expect(finished).toHaveAttribute("data-expanded", "false");
});

test("Stop stops the run in progress, and the card is free for the next", async ({
  mount,
}) => {
  const component = await mount(<AgentThreadsHarness />);
  const running = component.getByTestId("comment-thread").last();

  await running.getByRole("button", { name: "Stop" }).click();
  await expect(running.getByText("Stopping…")).toBeVisible();
  await expect(running.getByText("Stopped", { exact: true })).toBeVisible();
  await expect(running.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(running.getByTitle("Continue this run")).toBeVisible();
});
