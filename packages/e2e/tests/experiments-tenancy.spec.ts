/**
 * A/B experiments are scoped by `org_sites` ownership (like Infra Billing and
 * Monitor). Site slugs are globally unique and guessable (public hostnames), so
 * ownership is the only thing between one tenant and another's experiments. This
 * asserts, over the wire:
 *
 *   - the owning org creates + lists + updates + deletes its experiment;
 *   - a duplicate key on the same site is rejected;
 *   - a slug the org does not own is rejected on every tool (create/list/get);
 *   - a second org naming the owner's slug is refused, not served;
 *   - EXPERIMENT_RESULTS reports `available:false` on the e2e stack (no analytics
 *     warehouse credentials) rather than passing zeros off as a real result.
 *
 * Contract shapes are INLINED (black-box suite — no app imports).
 */

import { type Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface Experiment {
  id: string;
  site: string;
  key: string;
  name: string;
  status: string;
  variants: { id: string; weight: number }[];
}
interface CreateOut {
  experiment: Experiment;
}
interface ListOut {
  experiments: Experiment[];
}
interface ResultsOut {
  available: boolean;
  results: unknown;
}

async function seedOwnedSite(
  db: Client,
  orgSlug: string,
  userId: string,
): Promise<string> {
  const slug = `e2e-exp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const orgId = (
    await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [orgSlug],
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO org_sites (slug, organization_id, source, created_by, updated_by)
     VALUES ($1, $2, 'manual', $3, $3)`,
    [slug, orgId, userId],
  );
  return slug;
}

const VARIANTS = [
  { id: "control", weight: 50, role: "control" },
  { id: "variant-b", weight: 50, role: "treatment" },
];

test.describe("A/B experiments tenancy", () => {
  let db: Client;
  test.beforeAll(async () => {
    db = await connectDevDb();
  });
  test.afterAll(async () => {
    await db?.end();
  });

  test("only the owning org can manage a site's experiments", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const otherCtx = await newApiContext(playwright);
    const other = await signUpViaApi(otherCtx);
    expect(other.orgSlug).not.toBe(owner.orgSlug);

    const site = await seedOwnedSite(db, owner.orgSlug, owner.userId);

    // Create on the owned site.
    const created = await callSelfMcpTool<CreateOut>(
      ownerCtx,
      owner.orgSlug,
      "EXPERIMENT_CREATE",
      { site, key: "plp-ranking", name: "PLP ranking", variants: VARIANTS },
    );
    expect(created.experiment.key).toBe("plp-ranking");
    expect(created.experiment.status).toBe("draft");

    // Listed back.
    const list = await callSelfMcpTool<ListOut>(
      ownerCtx,
      owner.orgSlug,
      "EXPERIMENT_LIST",
      { site },
    );
    expect(list.experiments.map((e) => e.key)).toEqual(["plp-ranking"]);

    // Duplicate key on the same site is rejected.
    await expect(
      callSelfMcpTool(ownerCtx, owner.orgSlug, "EXPERIMENT_CREATE", {
        site,
        key: "plp-ranking",
        name: "dupe",
        variants: VARIANTS,
      }),
    ).rejects.toThrow(/already exists/i);

    // A slug the org does not own is rejected on every tool.
    const unowned = `${site}-not-owned`;
    for (const [tool, args] of [
      [
        "EXPERIMENT_CREATE",
        { site: unowned, key: "x", name: "x", variants: VARIANTS },
      ],
      ["EXPERIMENT_LIST", { site: unowned }],
      ["EXPERIMENT_GET", { site: unowned, key: "plp-ranking" }],
    ] as const) {
      await expect(
        callSelfMcpTool(ownerCtx, owner.orgSlug, tool, args),
      ).rejects.toThrow(/not found/i);
    }

    // A different tenant naming the owner's slug is refused, not served.
    await expect(
      callSelfMcpTool(otherCtx, other.orgSlug, "EXPERIMENT_LIST", { site }),
    ).rejects.toThrow(/not found/i);
    await expect(
      callSelfMcpTool(otherCtx, other.orgSlug, "EXPERIMENT_GET", {
        site,
        key: "plp-ranking",
      }),
    ).rejects.toThrow(/not found/i);

    // Update flips status; delete removes it.
    const updated = await callSelfMcpTool<CreateOut>(
      ownerCtx,
      owner.orgSlug,
      "EXPERIMENT_UPDATE",
      { site, key: "plp-ranking", status: "running" },
    );
    expect(updated.experiment.status).toBe("running");

    const del = await callSelfMcpTool<{ deleted: boolean }>(
      ownerCtx,
      owner.orgSlug,
      "EXPERIMENT_DELETE",
      { site, key: "plp-ranking" },
    );
    expect(del.deleted).toBe(true);

    const afterDelete = await callSelfMcpTool<ListOut>(
      ownerCtx,
      owner.orgSlug,
      "EXPERIMENT_LIST",
      { site },
    );
    expect(afterDelete.experiments).toEqual([]);

    // Unavailable on the e2e stack (no analytics warehouse) — never a fake zero.
    const results = await callSelfMcpTool<ResultsOut>(
      ownerCtx,
      owner.orgSlug,
      "EXPERIMENT_RESULTS",
      { site, key: "plp-ranking" },
    );
    expect(results.available).toBe(false);
    expect(results.results).toBeNull();

    // The results tool is also ownership-gated.
    await expect(
      callSelfMcpTool(otherCtx, other.orgSlug, "EXPERIMENT_RESULTS", {
        site,
        key: "plp-ranking",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
