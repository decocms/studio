import { expect, test } from "@playwright/experimental-ct-react";
import { SettingsHarness } from "./settings-harness";

/** Server-side state stand-in for organization_settings, with a two-level merge
 *  mirroring the PR's SQL. Every write payload the UI sends is recorded. */
type Bag = Record<string, unknown>;

const conn = (owner: string, repo: string) => ({
  id: `conn_${owner}_${repo}`,
  title: `${owner}/${repo}`,
  status: "active",
  metadata: { repoScope: { installationId: 1, owner, repo } },
});

function makeBackend(initial: Bag) {
  const state: Bag = { organizationId: "org_qa", ...initial };
  const writes: Bag[] = [];
  return {
    state,
    writes,
    handle(name: string, input: Bag) {
      if (name === "COLLECTION_CONNECTIONS_LIST") {
        return {
          items: [
            conn("decocms", "studio"),
            conn("decocms", "context"),
            conn("deco-sites", "decocms-tanstack"),
          ],
        };
      }
      if (name === "ORGANIZATION_SETTINGS_GET") return state;
      if (name === "ORGANIZATION_SETTINGS_UPDATE") {
        writes.push(structuredClone(input));
        if (input.flags) {
          state.flags = { ...(state.flags as Bag), ...(input.flags as Bag) };
        }
        if (input.repo_flags) {
          const next = { ...((state.repo_flags as Bag) ?? {}) } as Record<
            string,
            Bag
          >;
          for (const [repo, flags] of Object.entries(
            input.repo_flags as Record<string, Bag>,
          )) {
            next[repo] = { ...(next[repo] ?? {}), ...flags };
          }
          state.repo_flags = next;
        }
        return state;
      }
      return {};
    },
  };
}

type Backend = ReturnType<typeof makeBackend>;

async function install(
  page: import("@playwright/test").Page,
  backend: Backend,
) {
  await page.route("**/api/*/tools/*", async (route) => {
    const url = new URL(route.request().url());
    const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const input = route.request().postDataJSON() ?? {};
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(backend.handle(name, input)),
    });
  });
}

const sw = (
  c: import("@playwright/test").Locator,
  label: string,
  repo: string,
) => c.getByRole("switch", { name: `${label} — ${repo}` });

test("per-repo rows render, inherit workspace defaults, and can diverge", async ({
  mount,
  page,
}) => {
  const backend = makeBackend({
    flags: { qa_agent_enabled: true, code_reviewer_enabled: true },
    repo_flags: null,
  });
  await install(page, backend);
  const c = await mount(<SettingsHarness />);

  await expect(c.getByText("Per-repository overrides")).toBeVisible();
  for (const repo of [
    "decocms/studio",
    "decocms/context",
    "deco-sites/decocms-tanstack",
  ]) {
    await expect(c.getByText(repo, { exact: true })).toBeVisible();
  }
  await expect(c.getByText("Using workspace defaults")).toHaveCount(3);

  // Inherited effective values equal the workspace defaults.
  await expect(sw(c, "QA Agent", "decocms/studio")).toBeChecked();
  await expect(sw(c, "Code reviewer", "decocms/studio")).toBeChecked();
  await expect(sw(c, "Auto-merge", "decocms/studio")).not.toBeChecked();

  await c.screenshot({ path: "../../org/output/qa/after-inherited.png" });

  // The task's use case: diverge decocms/studio from the workspace default.
  await sw(c, "Auto-merge", "decocms/studio").click();
  await expect
    .poll(() => backend.writes.at(-1)?.repo_flags)
    .toEqual({ "decocms/studio": { auto_merge: true } });
  await sw(c, "Auto-merge", "decocms/studio").click();
  await expect
    .poll(() => backend.writes.at(-1)?.repo_flags)
    .toEqual({ "decocms/studio": { auto_merge: false } });
  await sw(c, "QA Agent", "decocms/studio").click();
  await sw(c, "QA Agent", "decocms/studio").click();
  await expect
    .poll(() => backend.state.repo_flags)
    .toEqual({
      "decocms/studio": { auto_merge: false, qa_agent_enabled: true },
    });

  // Only that repo diverges.
  await expect(c.getByText("Custom for this repository")).toHaveCount(1);
  await expect(c.getByText("Using workspace defaults")).toHaveCount(2);
  await expect(sw(c, "Auto-merge", "decocms/context")).not.toBeChecked();

  await c.screenshot({ path: "../../org/output/qa/after-overridden.png" });

  await c.getByRole("button", { name: "Reset" }).first().click();
  await expect
    .poll(() => backend.writes.at(-1)?.repo_flags)
    .toEqual({
      "decocms/studio": {
        qa_agent_enabled: null,
        code_reviewer_enabled: null,
        auto_merge: null,
      },
    });
  await expect(c.getByText("Using workspace defaults")).toHaveCount(3);
});

test("a repo with no override follows a change to the workspace default", async ({
  mount,
  page,
}) => {
  const backend = makeBackend({
    flags: { qa_agent_enabled: true, code_reviewer_enabled: true },
    repo_flags: { "decocms/studio": { auto_merge: false } },
  });
  await install(page, backend);
  const c = await mount(<SettingsHarness />);

  await c.getByRole("switch", { name: "Enable Auto-merge" }).first().click();
  await expect.poll(() => (backend.state.flags as Bag).auto_merge).toBe(true);

  await expect(sw(c, "Auto-merge", "decocms/context")).toBeChecked();
  await expect(sw(c, "Auto-merge", "decocms/studio")).not.toBeChecked();
});

test("baseline: org-only settings section (before)", async ({
  mount,
  page,
}) => {
  const backend = makeBackend({
    flags: { qa_agent_enabled: true, code_reviewer_enabled: true },
    repo_flags: null,
  });
  await install(page, backend);
  const c = await mount(<SettingsHarness perRepo={false} />);
  await expect(c.getByText("Per-repository overrides")).toHaveCount(0);
  await c.screenshot({ path: "../../org/output/qa/before-desktop.png" });
});

test.describe("mobile", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true });
  test("per-repo rows on a phone viewport", async ({ mount, page }) => {
    const backend = makeBackend({
      flags: { qa_agent_enabled: true, code_reviewer_enabled: true },
      repo_flags: { "decocms/studio": { auto_merge: false } },
    });
    await install(page, backend);
    const c = await mount(<SettingsHarness />);
    await expect(c.getByText("Per-repository overrides")).toBeVisible();
    await page.screenshot({
      path: "../../org/output/qa/after-mobile.png",
      fullPage: true,
    });
  });
});
