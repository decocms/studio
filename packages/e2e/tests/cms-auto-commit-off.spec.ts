/**
 * E2E: Fast Preview with the org's `cms_auto_commit` flag off.
 *
 * A save is held in Studio instead of becoming a commit. Every read lays it
 * over the branch head (the editor's GET and the preview's anonymous pull),
 * the `/git/*` routes the publish surface reads count it as uncommitted work,
 * and the publish flow's push step commits it in one commit.
 *
 * Setup mirrors `cms-publish-surface`: sandbox-less Fast Preview against the
 * local Git Data stub, with a dead GitHub MCP connection so the header settles
 * on its no-open-PR state. Wire-contract strings are inlined on purpose.
 */

import type { APIRequestContext } from "@playwright/test";
import {
  createFastPreviewProject,
  type FastPreviewProject,
  inspectStubRepo,
  seedStubRepo,
  uniqueOwner,
} from "../fixtures/fast-preview";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

const SHELL_TIMEOUT_MS = 60_000;

/** UI copy — the header's split button and the popover's chrome. */
const REVIEW_AND_PUBLISH = "Review & Publish";
const MORE_ACTIONS = "More actions";
const SUBMIT_FOR_REVIEW = "Submit for review";

/** A held draft's version: the head sha plus a digest of the held rows. */
const HELD_VERSION = /^[0-9a-f]{40}\.[0-9a-f]{16}$/;

const blockFileContent = (value: unknown): string =>
  `${JSON.stringify(value, null, 2)}\n`;

const HERO_FILE = ".deco/blocks/Hero.json";

async function turnAutoCommitOff(
  api: APIRequestContext,
  org: string,
): Promise<void> {
  const { id: organizationId } = await callSelfMcpTool<{ id: string }>(
    api,
    org,
    "ORGANIZATION_GET",
    {},
  );
  await callSelfMcpTool(api, org, "ORGANIZATION_SETTINGS_UPDATE", {
    organizationId,
    flags: { cms_auto_commit: false },
  });
}

async function setup(api: APIRequestContext, org: string, branch: string) {
  const owner = uniqueOwner();
  const repo = "site";
  await seedStubRepo(api, {
    owner,
    repo,
    defaultBranch: "main",
    branches: {
      main: { files: { [HERO_FILE]: '{"title":"old"}\n' } },
      [branch]: null,
    },
  });
  const project = await createFastPreviewProject(api, org, {
    owner,
    repo,
    connectionUrl: "http://127.0.0.1:1/unused",
  });
  await turnAutoCommitOff(api, org);
  return project;
}

const decofileUrl = (p: FastPreviewProject, branch: string): string =>
  `/api/${p.org}/decofile/${p.vmcpId}/${branch}`;

test.describe("fast preview with auto-commit off", () => {
  test("a save is held: no commit, every read shows it, git status lists it", async ({
    authedPage,
    playwright,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const branch = "draft";
    const project = await setup(api, orgSlug, branch);
    const url = decofileUrl(project, branch);

    const before = (await (await api.get(url)).json()) as { version: string };
    const commitsBefore = (
      await inspectStubRepo(api, project.owner, project.repo)
    ).commits.length;

    const hero = { __resolveType: "site/sections/Hero.tsx", title: "Held" };
    const patch = await api.patch(url, { data: { set: { Hero: hero } } });
    expect(patch.status()).toBe(200);
    const saved = (await patch.json()) as { version: string; token: string };
    expect(saved.version).toMatch(HELD_VERSION);
    expect(saved.version.startsWith(before.version)).toBe(true);

    const stub = await inspectStubRepo(api, project.owner, project.repo);
    expect(stub.commits.length).toBe(commitsBefore);
    expect(stub.branches[branch]?.files[HERO_FILE]).toBe('{"title":"old"}\n');

    // The editor's read.
    const editor = (await (await api.get(url)).json()) as {
      version: string;
      decofile: Record<string, unknown>;
    };
    expect(editor.version).toBe(saved.version);
    expect(editor.decofile["Hero"]).toEqual(hero);

    // The preview's anonymous pull, with the token the save handed back.
    const anonymous = await newApiContext(playwright);
    try {
      const pulled = await anonymous.get(
        `${url}?token=${encodeURIComponent(saved.token)}`,
      );
      expect(pulled.status()).toBe(200);
      expect(
        ((await pulled.json()) as Record<string, unknown>)["Hero"],
      ).toEqual(hero);
    } finally {
      await anonymous.dispose();
    }

    // The publish surface's status and diff count it as uncommitted work.
    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: project.vmcpId, branch } },
    );
    const git = `/api/${orgSlug}/sandbox/${project.vmcpId}/${branch}/git`;
    const status = (await (
      await api.get(`${git}/status?thread=${thread.item.id}`)
    ).json()) as {
      headSha: string;
      modified: string[];
      changedFiles: Array<{ path: string; status: string }>;
    };
    expect(status.headSha).toBe(saved.version);
    expect(status.modified).toEqual([HERO_FILE]);
    expect(status.changedFiles).toEqual([
      { path: HERO_FILE, status: "modified" },
    ]);
    const diff = (await (
      await api.post(`${git}/diff?thread=${thread.item.id}`, { data: {} })
    ).json()) as { diffs: Record<string, { from: string; to: string }> };
    expect(diff.diffs[HERO_FILE]).toEqual({
      from: '{"title":"old"}\n',
      to: blockFileContent(hero),
    });

    // Discarding it drops the held save; the head never moved.
    const discard = await api.post(`${git}/discard?thread=${thread.item.id}`, {
      data: { filepaths: [HERO_FILE] },
    });
    expect(discard.status()).toBe(200);
    const afterDiscard = (await (await api.get(url)).json()) as {
      version: string;
      decofile: Record<string, unknown>;
    };
    expect(afterDiscard.version).toBe(before.version);
    expect(afterDiscard.decofile["Hero"]).toEqual({ title: "old" });
    expect(
      (await inspectStubRepo(api, project.owner, project.repo)).commits.length,
    ).toBe(commitsBefore);
  });

  test("the header offers the held save, and submitting it commits it once", async ({
    authedPage,
  }) => {
    test.slow();
    const { page, orgSlug } = authedPage;
    const api = page.context().request;
    const branch = "draft";
    const project = await setup(api, orgSlug, branch);
    const url = decofileUrl(project, branch);

    const thread = await callSelfMcpTool<{
      item: { id: string; branch: string | null };
    }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
      data: { virtual_mcp_id: project.vmcpId, branch },
    });
    expect(thread.item.branch).toBe(branch);

    const hero = { __resolveType: "site/sections/Hero.tsx", title: "Held" };
    expect(
      (await api.patch(url, { data: { set: { Hero: hero } } })).status(),
    ).toBe(200);
    const commitsBefore = (
      await inspectStubRepo(api, project.owner, project.repo)
    ).commits.length;

    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${project.vmcpId}&main=preview`,
    );

    // Nothing is committed, yet the header has work to publish.
    await expect(
      page.getByRole("button", { name: REVIEW_AND_PUBLISH, exact: true }),
    ).toBeVisible({ timeout: SHELL_TIMEOUT_MS });

    await page.getByRole("button", { name: MORE_ACTIONS }).click();
    await page
      .getByRole("menuitem", { name: SUBMIT_FOR_REVIEW, exact: true })
      .click();
    await page
      .getByRole("button", { name: SUBMIT_FOR_REVIEW, exact: true })
      .click();

    // The push step commits the held save; the flow then opens the PR.
    await expect
      .poll(
        async () =>
          (await inspectStubRepo(api, project.owner, project.repo)).branches[
            branch
          ]?.files[HERO_FILE],
        { timeout: 30_000 },
      )
      .toBe(blockFileContent(hero));
    const stub = await inspectStubRepo(api, project.owner, project.repo);
    expect(stub.commits.length).toBe(commitsBefore + 1);

    // Nothing is held any more: the draft's version is the head again.
    const after = (await (await api.get(url)).json()) as { version: string };
    expect(after.version).toBe(stub.branches[branch]?.headSha);
  });
});
