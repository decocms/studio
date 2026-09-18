import { expect, test } from "@playwright/experimental-ct-react";
import {
  ClockTickHarness,
  IsMobileHarness,
} from "../harness/clock-harness.tsx";

/**
 * Both hooks read a mutable source outside React — the wall clock and the
 * viewport. Reading either during render is impure (`react/purity`) and
 * copying it in with an effect leaves a gap before the first commit
 * (`react/set-state-in-effect`), so both go through `useSyncExternalStore`.
 *
 * That shape has one failure mode worth a test: a `getSnapshot` that returns a
 * fresh value every call makes `useSyncExternalStore` re-render forever. These
 * tests would hang or time out if that regressed, which is the point.
 */

const MOBILE_WIDTH = { width: 500, height: 800 };
const DESKTOP_WIDTH = { width: 1200, height: 800 };

test("useClockTick returns a real timestamp, not a counter", async ({
  mount,
}) => {
  const before = Date.now();
  const component = await mount(<ClockTickHarness intervalMs={100} />);

  const first = Number(await component.getByTestId("now").textContent());
  // A counter would start at 0; a timestamp lands near the wall clock.
  expect(first).toBeGreaterThanOrEqual(before - 60_000);
  expect(first).toBeLessThanOrEqual(Date.now() + 1_000);
});

test("useClockTick advances on its own without re-mounting", async ({
  mount,
}) => {
  const component = await mount(<ClockTickHarness intervalMs={100} />);
  const first = Number(await component.getByTestId("now").textContent());

  await expect
    .poll(
      async () => Number(await component.getByTestId("now").textContent()),
      {
        timeout: 5_000,
      },
    )
    .toBeGreaterThan(first);
});

test("useIsMobile reports the viewport on first paint", async ({
  mount,
  page,
}) => {
  await page.setViewportSize(MOBILE_WIDTH);
  const component = await mount(<IsMobileHarness />);

  // The effect version rendered "desktop" first and corrected after commit;
  // subscribing directly means the very first paint is already right.
  await expect(component.getByTestId("is-mobile")).toHaveText("mobile");
});

test("useIsMobile follows a viewport change", async ({ mount, page }) => {
  await page.setViewportSize(DESKTOP_WIDTH);
  const component = await mount(<IsMobileHarness />);
  await expect(component.getByTestId("is-mobile")).toHaveText("desktop");

  await page.setViewportSize(MOBILE_WIDTH);
  await expect(component.getByTestId("is-mobile")).toHaveText("mobile");
});
