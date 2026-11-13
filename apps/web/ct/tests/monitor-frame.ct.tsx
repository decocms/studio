import { expect, test } from "@playwright/experimental-ct-react";
import { MonitorFrameHarness } from "../harness/monitor-frame-harness";

/**
 * The main panel clips its body, so a Monitor view taller than the panel was
 * cut off unless something inside scrolled. These guard that a visitor's
 * wheel reaches every view's last line, and that the panel itself never moves.
 */

test("scrolls a view that has no scroller of its own", async ({
  mount,
  page,
}) => {
  const component = await mount(<MonitorFrameHarness view="tall" />);
  const panel = component.getByTestId("panel");
  const end = component.getByTestId("end");
  await expect(end).not.toBeInViewport();

  await panel.hover();
  await page.mouse.wheel(0, 3000);
  await expect(end).toBeInViewport();
  expect(await panel.evaluate((el) => el.scrollTop)).toBe(0);
});

test("lets a view with its own scroller fill the frame", async ({
  mount,
  page,
}) => {
  const component = await mount(<MonitorFrameHarness view="scroller" />);
  const own = component.getByTestId("own");
  const frame = own.locator("xpath=../..");
  // The view's scroller takes the height below the tabs, so the frame has
  // nothing left to scroll.
  const [ownHeight, frameHeight, frameOverflow] = await Promise.all([
    own.evaluate((el) => el.clientHeight),
    frame.evaluate((el) => el.clientHeight),
    frame.evaluate((el) => el.scrollHeight - el.clientHeight),
  ]);
  expect(ownHeight).toBe(frameHeight - 40);
  expect(frameOverflow).toBe(0);

  await own.hover();
  await page.mouse.wheel(0, 3000);
  await expect(component.getByTestId("end")).toBeInViewport();
  expect(await own.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});
