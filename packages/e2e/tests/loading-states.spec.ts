/**
 * E2E: the app has exactly two loading states, and they only ever run forwards.
 *
 * The contract under test is a SEQUENCE, so this spec watches one, rather than
 * sampling the DOM at a moment of its choosing. Two states are allowed:
 *
 *   1. the splash — full viewport, while the app SHELL's own data resolves;
 *   2. one spinner gating the main panel, with the shell painted around it.
 *
 * From that follows the invariant this file pins: once the shell has painted,
 * no in-app navigation may put the splash back, and none may take the shell
 * down. Both are transitions *backwards* — the app un-loading — and both were
 * real: a settings route that named no pending component fell back to a
 * full-screen splash rendered inside the settings card, and an org switch
 * re-suspended the shell's active-organization query.
 *
 * The splash also has to run exactly ONCE per boot, which presence sampling
 * cannot see: five different boundaries used to relay the boot between them, and
 * a watcher that only asks "is a splash on screen?" reads an unbroken splash
 * while the element under it is swapped and its animation restarts from zero.
 * So the watchers below count MOUNTS — distinct `.deco-splash` elements — not
 * appearances.
 *
 * `page.goto()` proves nothing for the two navigation tests: it boots the app,
 * so of course the splash runs. Their navigations are therefore clicks, and the
 * observer is armed only AFTER the first paint has settled. The boot test is
 * the exception, and arms itself before the first script instead.
 *
 * Selectors are the house ones (`data-slot`), not copy — this suite owns its
 * contract and imports no app code (`plugins/ban-e2e-app-imports.js`). The one
 * class name, `.deco-splash`, IS the splash's identity in the DOM.
 */

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";

/** Cold-Vite route compiles can take a minute+ on a loaded box, and reaching
 *  the shell crosses several lazy chunks. */
const SHELL_TIMEOUT_MS = 90_000;

/** The shell: if this is on screen, the sidebar and the panel frame are. */
const shell = (page: Page) => page.locator('[data-slot="sidebar"]').first();

interface LoadingWatch {
  /** Every time the full-screen splash appeared, with the path it appeared on. */
  splashHits: string[];
  /** Every DISTINCT splash element inserted, with the path it landed on. A
   *  splash that is torn down and replaced reads as one continuous appearance
   *  in `splashHits` but as two here. */
  splashMounts: string[];
  /** Every time the shell went missing after having been on screen. */
  shellLosses: string[];
  /** How many times the watcher actually sampled. An empty `splashHits` proves
   *  nothing if this is 0 — a throttled rAF would look exactly like a pass. */
  samples: number;
}

/**
 * Start watching for backwards transitions. Samples the DOM for a state rather
 * than reading mutation records, because what matters is whether either thing
 * was ever ON SCREEN, not which node changed — but it samples ON every mutation
 * as well as every frame, so a fallback that lives less than one frame still
 * registers.
 */
async function armLoadingWatch(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = {
      splashHits: [] as string[],
      splashMounts: [] as string[],
      shellLosses: [] as string[],
      samples: 0,
    };
    (window as unknown as { __loadingWatch: typeof state }).__loadingWatch =
      state;
    let splashUpBefore = false;
    let shellUpBefore = false;
    const sample = () => {
      state.samples += 1;
      const splashUp = !!document.querySelector(".deco-splash");
      const shellUp = !!document.querySelector('[data-slot="sidebar"]');
      /* Rising and falling EDGES only: one entry per appearance/disappearance,
         not one per frame it stayed that way. */
      if (splashUp && !splashUpBefore) state.splashHits.push(location.pathname);
      if (shellUpBefore && !shellUp) state.shellLosses.push(location.pathname);
      splashUpBefore = splashUp;
      shellUpBefore = shellUp;
    };
    /* A mutation observer is the load-bearing sampler: it fires on the very
       commit that swaps a fallback in, so a loader that lives for less than a
       frame is still caught. The rAF loop is only a backstop for a state that
       arrives without a DOM mutation. */
    const seen = new WeakSet<Element>();
    const countMounts = () => {
      for (const el of document.querySelectorAll(".deco-splash")) {
        if (seen.has(el)) continue;
        seen.add(el);
        state.splashMounts.push(location.pathname);
      }
    };
    new MutationObserver(() => {
      countMounts();
      sample();
    }).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    const tick = () => {
      sample();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    sample();
  });
}

async function readLoadingWatch(page: Page): Promise<LoadingWatch> {
  return page.evaluate(() => {
    const w = window as unknown as { __loadingWatch?: LoadingWatch };
    return (
      w.__loadingWatch ?? {
        splashHits: [],
        splashMounts: [],
        shellLosses: [],
        samples: 0,
      }
    );
  });
}

/** Boot the app the one time a full page load is allowed, and settle. */
async function bootShell(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(shell(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });
}

test.describe("loading states", () => {
  /** Reaching several lazy route chunks runs past Playwright's 30s default. */
  test.describe.configure({ timeout: 240_000 });

  test("in-app navigation never re-runs the splash or drops the shell", async ({
    authedPage: { page, orgSlug },
  }) => {
    await bootShell(page, `/${orgSlug}/home`);
    await armLoadingWatch(page);

    /* Settings is the crossing that used to blank: it leaves the org shell for
       a sibling layout, and its leaf routes named no pending component. */
    await page
      .locator(`[data-slot="sidebar"] a[href^="/${orgSlug}/settings"]`)
      .first()
      .click();
    await page.waitForURL(
      (url) => url.pathname.startsWith(`/${orgSlug}/settings`),
      {
        timeout: SHELL_TIMEOUT_MS,
      },
    );
    /* Settings redirects its index onward, so wait for the destination too —
       the second hop is where the second splash used to appear. */
    await page.waitForURL((url) => url.pathname !== `/${orgSlug}/settings`, {
      timeout: SHELL_TIMEOUT_MS,
    });

    await page
      .locator(`[data-slot="sidebar"] a[href="/${orgSlug}/home"]`)
      .first()
      .click();
    await page.waitForURL((url) => url.pathname === `/${orgSlug}/home`, {
      timeout: SHELL_TIMEOUT_MS,
    });

    const watch = await readLoadingWatch(page);
    /* Guard the guard: zero samples would make every assertion below vacuous. */
    expect(watch.samples).toBeGreaterThan(0);
    expect(watch.splashHits).toEqual([]);
    expect(watch.splashMounts).toEqual([]);
    expect(watch.shellLosses).toEqual([]);
  });

  test("switching organization keeps the shell painted", async ({
    authedPage: { page, orgSlug },
  }) => {
    await bootShell(page, `/${orgSlug}/home`);

    /* A second org to switch INTO. Created from inside the page so it is a real
       same-origin browser request carrying the session cookie and Origin. */
    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const secondSlug = `e2e-loader-${suffix}`;
    const created = await page.evaluate(async (slug) => {
      const res = await fetch("/api/auth/organization/create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: slug, slug }),
      });
      return res.status;
    }, secondSlug);
    expect(created).toBeLessThan(400);

    /* Reload so the picker lists the new org. This goto is SETUP — the watch is
       armed after it, so the boot splash it runs is not what is being measured. */
    await bootShell(page, `/${orgSlug}/home`);
    await armLoadingWatch(page);

    /* The picker is the ONE in-app control that changes `$org`, so it is the
       only way to exercise this without a reload. Open it and click the row —
       do NOT type into its search box: the box searches AGENTS, not orgs, so a
       filtered list would hide the very row this test needs. */
    await page
      .locator('[data-slot="sidebar"] button[aria-label^="Organization"]')
      .first()
      .click();
    await page
      .getByRole("option", { name: secondSlug, exact: false })
      .first()
      .click();

    await page.waitForURL((url) => url.pathname.startsWith(`/${secondSlug}`), {
      timeout: SHELL_TIMEOUT_MS,
    });
    await expect(shell(page)).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    const watch = await readLoadingWatch(page);
    /* Guard the guard: zero samples would make every assertion below vacuous. */
    expect(watch.samples).toBeGreaterThan(0);
    expect(watch.splashHits).toEqual([]);
    expect(watch.splashMounts).toEqual([]);
    expect(watch.shellLosses).toEqual([]);
  });

  test("boot mounts the splash exactly once", async ({
    authedPage: { page, orgSlug },
  }) => {
    /* Armed before the app's first script, because the thing being counted
       happens in the first few hundred milliseconds of boot. */
    await page.addInitScript(() => {
      const state = {
        mounts: [] as string[],
        animations: [] as string[],
      };
      (window as unknown as { __bootWatch: typeof state }).__bootWatch = state;
      const seen = new WeakSet<Element>();
      const countMounts = () => {
        for (const el of document.querySelectorAll(".deco-splash")) {
          if (seen.has(el)) continue;
          seen.add(el);
          state.mounts.push(location.pathname);
        }
      };
      /* `document`, not `document.documentElement`: an init script runs at
         document-start, before the root element exists, and observing `null`
         would throw and take the whole watcher with it — silently reporting
         zero mounts on a boot that had two. */
      new MutationObserver(countMounts).observe(document, {
        childList: true,
        subtree: true,
      });
      document.addEventListener(
        "animationstart",
        (event) => {
          if (event.animationName.startsWith("deco-splash")) {
            state.animations.push(event.animationName);
          }
        },
        true,
      );
    });

    await bootShell(page, `/${orgSlug}/home`);

    const boot = await page.evaluate(() => {
      const w = window as unknown as {
        __bootWatch?: { mounts: string[]; animations: string[] };
      };
      return w.__bootWatch ?? { mounts: [], animations: [] };
    });

    /* THE invariant: one element from first paint to shell paint. Two means a
       boundary handed off to another, and the splash's wave-fill restarted. */
    expect(boot.mounts).toHaveLength(1);

    /* The symptom, read directly. Each of the splash's animations may start at
       most once — a second start on the same name IS the replay a user sees.
       An empty list is allowed and not vacuous: the assertion above already
       pinned the mount count, and `prefers-reduced-motion` legitimately runs
       no animations at all. */
    expect(boot.animations).toEqual([...new Set(boot.animations)]);
  });
});
