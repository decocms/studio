/**
 * The board's project filter — the control that used to say "Repo".
 *
 * A repository is how a project is identified on a card, so the board offers
 * one list: projects, named as you know them, with the repository they pin
 * underneath. This pins the three things a unit test cannot reach — what the
 * picker RENDERS, what the URL carries, and that a link written before the
 * merge still narrows the board it lands on.
 *
 * No run is dispatched and no GitHub connection is created: buckets come from
 * each project's `metadata.githubRepo`, so this depends on no model tier, no
 * provider, and no installation.
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, test } from "../fixtures/test";

/** Black-box wire-contract shapes (owned by this test, per e2e isolation rules). */
interface CreatedItem {
  id: string;
  title: string;
  virtualMcpId: string | null;
  repo: string | null;
}

/** Unique per run so two workers' orgs never name the same repository. */
function repoNames(seed: string) {
  return { mono: `acme-${seed}/mono`, solo: `acme-${seed}/solo` };
}

async function seedProject(
  request: APIRequestContext,
  orgSlug: string,
  title: string,
  repo: string,
) {
  const [owner, name] = repo.split("/");
  return callSelfMcpTool<{ item: { id: string } }>(
    request,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title,
        description: null,
        status: "active",
        pinned: false,
        connections: [],
        metadata: {
          githubRepo: { url: `https://github.com/${repo}`, owner, name },
        },
      },
    },
  );
}

async function seedCard(
  request: APIRequestContext,
  orgSlug: string,
  title: string,
  repo: string | null,
  virtualMcpId?: string,
) {
  const { item } = await callSelfMcpTool<{ item: CreatedItem }>(
    request,
    orgSlug,
    "TASK_BOARD_ITEM_CREATE",
    {
      title,
      ...(repo ? { repo } : {}),
      ...(virtualMcpId ? { virtualMcpId } : {}),
    },
  );
  return item;
}

async function listCards(request: APIRequestContext, orgSlug: string) {
  return (
    await callSelfMcpTool<{ items: CreatedItem[] }>(
      request,
      orgSlug,
      "TASK_BOARD_ITEM_LIST",
      {},
    )
  ).items;
}

async function openBoard(page: Page, orgSlug: string, search = "") {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`/${orgSlug}/tasks${search}`);
}

const card = (page: Page, title: string) =>
  page.locator(`button:has-text("${title}")`);

/**
 * The board's filter chip, named by the label it wears rather than a test id —
 * what it SAYS is half of what this suite is about.
 *
 * Scoped to the main panel because the sidebar's org/project picker is also a
 * button whose accessible name contains "project"; the two controls answer
 * different questions and this suite is only about the board's.
 */
const chip = (page: Page, label: string) =>
  page.getByTestId("main-panel").getByRole("button", { name: label });

/** The open picker's rows. Scoped for the same reason the chip is: the sidebar
 *  lists the org's projects by name too, and this suite is about the board's
 *  control, not that one. */
const option = (page: Page, label: string) =>
  page.locator("[cmdk-list]").getByText(label, { exact: true });

test.describe("task board project filter", () => {
  test("validates and persists project ownership without same-repo leakage", async ({
    authedPage,
  }) => {
    test.setTimeout(60_000);
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const originalTitle = `Untouched ${orgSlug}`;
    const invalidTitle = `Invalid ${orgSlug}`;
    const existing = await seedCard(request, orgSlug, originalTitle, null);
    const missingProject = `vir_missing_${orgSlug}`;

    await expect(
      callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_CREATE", {
        title: invalidTitle,
        virtualMcpId: missingProject,
      }),
    ).rejects.toThrow(/virtual mcp not found/i);
    await expect(
      callSelfMcpTool(request, orgSlug, "TASK_BOARD_ITEM_UPDATE", {
        id: existing.id,
        title: invalidTitle,
        virtualMcpId: missingProject,
      }),
    ).rejects.toThrow(/virtual mcp not found/i);

    const unchangedCards = await listCards(request, orgSlug);
    expect(unchangedCards.some((item) => item.title === invalidTitle)).toBe(
      false,
    );
    expect(
      unchangedCards.find((item) => item.id === existing.id),
    ).toMatchObject({
      title: originalTitle,
      virtualMcpId: null,
    });

    const { mono } = repoNames(orgSlug);
    const projectA = (await seedProject(request, orgSlug, "Storefront", mono))
      .item;
    const projectB = (await seedProject(request, orgSlug, "Checkout", mono))
      .item;
    const title = `Owned ${orgSlug}`;

    await page.goto(`/${orgSlug}/projects/${projectA.id}/tasks`);
    const main = page.getByTestId("main-panel");
    await main.getByRole("button", { name: "New task", exact: true }).click();
    await page.getByPlaceholder("Task title...").fill(title);
    await page.getByRole("button", { name: "Create task" }).click();

    await expect
      .poll(async () => {
        const item = (await listCards(request, orgSlug)).find(
          (candidate) => candidate.title === title,
        );
        return item?.virtualMcpId;
      })
      .toBe(projectA.id);
    await expect(card(page, title)).toBeVisible();

    await card(page, title).click();
    await main.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Clone" }).click();
    await expect
      .poll(async () => {
        const clone = (await listCards(request, orgSlug)).find(
          (candidate) => candidate.title === `${title} (copy)`,
        );
        return clone?.virtualMcpId;
      })
      .toBe(projectA.id);

    await page.goto(`/${orgSlug}/projects/${projectB.id}/tasks`);
    await expect(card(page, title)).toBeHidden();
    await expect(card(page, `${title} (copy)`)).toBeHidden();
  });

  test("offers projects by name, merges a shared repository, and narrows the board", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const { mono, solo } = repoNames(orgSlug);

    await seedProject(request, orgSlug, "Storefront", mono);
    await seedProject(request, orgSlug, "Checkout", mono);
    await seedProject(request, orgSlug, "Marketing Site", solo);
    await seedCard(request, orgSlug, "Monorepo work", mono);
    await seedCard(request, orgSlug, "Site work", solo);
    await seedCard(request, orgSlug, "Unfiled work", null);

    await openBoard(page, orgSlug);
    await expect(card(page, "Site work")).toBeVisible({ timeout: 30_000 });

    await chip(page, "Project").click();

    /** A project you recognize, not `owner/name` — the whole point of the
     *  merge. The repository is the subtitle. */
    await expect(option(page, "Marketing Site")).toBeVisible();

    /** Two projects, one repository, ONE row — titled with the repository and
     *  naming both, rather than a row per project that select the same cards.
     *  The map this replaced kept whichever project it iterated last. */
    await expect(option(page, mono)).toHaveCount(1);
    await expect(option(page, "Storefront, Checkout")).toBeVisible();

    await option(page, "Marketing Site").click();

    await expect(card(page, "Site work")).toBeVisible();
    await expect(card(page, "Monorepo work")).toBeHidden();
    await expect(card(page, "Unfiled work")).toBeHidden();
    /** The board's filter and the ambient app-wide scope stay two questions:
     *  picking a project here must never write `?virtualmcpid=`, which would
     *  re-couple them and hide every unclassified card app-wide.
     *
     *  Read as parsed params rather than matched against a pattern built from
     *  `solo`: a repository name is not regex- or percent-escaped by anything
     *  here, and `searchParams` decodes it for us. */
    await expect
      .poll(() => new URL(page.url()).searchParams.get("repo"))
      .toBe(solo);
    expect(new URL(page.url()).searchParams.get("virtualmcpid")).toBeNull();
    /** The chip reads the PROJECT, not the repository it pins. */
    await expect(chip(page, "Marketing Site")).toBeVisible();
  });

  test("the no-project bucket holds exactly the cards nothing claims", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const { solo } = repoNames(orgSlug);

    await seedProject(request, orgSlug, "Marketing Site", solo);
    await seedCard(request, orgSlug, "Site work", solo);
    await seedCard(request, orgSlug, "Unfiled work", null);

    await openBoard(page, orgSlug);
    await expect(card(page, "Site work")).toBeVisible({ timeout: 30_000 });

    await chip(page, "Project").click();
    await option(page, "No project").click();

    await expect(card(page, "Unfiled work")).toBeVisible();
    await expect(card(page, "Site work")).toBeHidden();
    /** The sentinel's WIRE VALUE is unchanged from the repo filter's, so a
     *  link written before the merge still selects this control. */
    await expect
      .poll(() => new URL(page.url()).searchParams.get("repo"))
      .toBe("__no_repo__");
  });

  /** A `?repo=` link anyone shared before the merge. The key did not change,
   *  and GitHub reads `owner/repo` case-insensitively, so both still hold. */
  test("a link written against the old repo filter still narrows", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const request = page.context().request;
    const { solo } = repoNames(orgSlug);

    await seedProject(request, orgSlug, "Marketing Site", solo);
    await seedCard(request, orgSlug, "Site work", solo);
    await seedCard(request, orgSlug, "Unfiled work", null);

    const shouted = solo.toUpperCase();
    await openBoard(page, orgSlug, `?repo=${encodeURIComponent(shouted)}`);

    await expect(card(page, "Site work")).toBeVisible({ timeout: 30_000 });
    await expect(card(page, "Unfiled work")).toBeHidden();
  });
});
