/**
 * Real-Postgres coverage for migration 226. What has to hold: the old default
 * names become "Deco Score", a name someone edited stays, only the diagnostic's
 * pinned view is relabeled, a row whose metadata never parsed does not abort
 * the run, and `down` puts the defaults back.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { sql } from "kysely";
import type { StudioDatabase } from "../src/database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../src/database/test-db-pg";
import { down, up } from "./226-deco-score-names";

setDefaultTimeout(30_000);

const USER = "user_226";
const ORG_DEFAULT = "org_226_default";
const ORG_EDITED = "org_226_edited";
const ORG_BROKEN = "org_226_broken";
/** Onboarded before #7244: still carries the name before "Report". */
const ORG_LEGACY = "org_226_legacy";

const pinnedViews = (label: string) =>
  JSON.stringify({
    type: "commerce-discovery",
    ui: {
      pinnedViews: [
        { connectionId: "c", toolName: "get_my_diagnostic", label },
        { connectionId: "c", toolName: "other_tool", label: "Report" },
      ],
    },
  });

describe("226 deco score names", () => {
  let database: StudioDatabase;

  const row = async (id: string) =>
    (
      await sql<{
        title: string;
        description: string | null;
        metadata: string | null;
      }>`
        SELECT title, description, metadata FROM connections WHERE id = ${id}
      `.execute(database.db)
    ).rows[0];

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const db = database.db;

    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${USER}, 'u226@e2e.local', true, 'u226', now(), now())
    `.execute(db);

    const conn = async (
      id: string,
      org: string,
      type: "HTTP" | "VIRTUAL",
      title: string,
      description: string,
      metadata: string | null,
    ) => {
      await sql`
        INSERT INTO connections (
          id, organization_id, title, description, connection_type,
          connection_url, metadata, status, pinned,
          created_by, updated_by, created_at, updated_at
        ) VALUES (
          ${id}, ${org}, ${title}, ${description}, ${type},
          ${"https://cd.example/" + id}, ${metadata}, 'active', false,
          ${USER}, ${USER}, now(), now()
        )
      `.execute(db);
    };

    for (const org of [ORG_DEFAULT, ORG_EDITED, ORG_BROKEN, ORG_LEGACY]) {
      await sql`
        INSERT INTO organization (id, name, slug, "createdAt")
        VALUES (${org}, ${org}, ${org.replace(/_/g, "-")}, now())
      `.execute(db);
    }

    await conn(
      `${ORG_DEFAULT}_commerce-discovery`,
      ORG_DEFAULT,
      "HTTP",
      "Store Report",
      "Your store's report and diagnostics",
      null,
    );
    await conn(
      `commerce-discovery_${ORG_DEFAULT}`,
      ORG_DEFAULT,
      "VIRTUAL",
      "Report Agent",
      "Ask anything about your store's report",
      pinnedViews("Report"),
    );
    await conn(
      `${ORG_EDITED}_commerce-discovery`,
      ORG_EDITED,
      "HTTP",
      "Our storefront",
      "Your store's report and diagnostics",
      null,
    );
    await conn(
      `commerce-discovery_${ORG_EDITED}`,
      ORG_EDITED,
      "VIRTUAL",
      "Shop assistant",
      "Ask anything about your store's report",
      pinnedViews("Scorecard"),
    );
    await conn(
      `commerce-discovery_${ORG_BROKEN}`,
      ORG_BROKEN,
      "VIRTUAL",
      "Report Agent",
      "Ask anything about your store's report",
      "{not json",
    );

    await conn(
      `${ORG_LEGACY}_commerce-discovery`,
      ORG_LEGACY,
      "HTTP",
      "Commerce Discovery",
      "Commerce Discovery report and commerce diagnostics.",
      null,
    );
    await conn(
      `commerce-discovery_${ORG_LEGACY}`,
      ORG_LEGACY,
      "VIRTUAL",
      "Commerce Discovery",
      "Commerce report and diagnostics",
      pinnedViews("Commerce Discovery"),
    );

    await up(db as never);
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("renames the default connection and agent", async () => {
    expect(await row(`${ORG_DEFAULT}_commerce-discovery`)).toMatchObject({
      title: "Deco Score",
      description: "Your store's Deco Score",
    });
    expect(await row(`commerce-discovery_${ORG_DEFAULT}`)).toMatchObject({
      title: "Deco Score Agent",
      description: "Ask anything about your store's Deco Score",
    });
  });

  it("relabels only the diagnostic's pinned view", async () => {
    const meta = JSON.parse(
      (await row(`commerce-discovery_${ORG_DEFAULT}`))?.metadata ?? "{}",
    );
    expect(meta.type).toBe("commerce-discovery");
    expect(meta.ui.pinnedViews).toEqual([
      { connectionId: "c", toolName: "get_my_diagnostic", label: "Deco Score" },
      { connectionId: "c", toolName: "other_tool", label: "Report" },
    ]);
  });

  it("keeps names someone edited, per field", async () => {
    expect(await row(`${ORG_EDITED}_commerce-discovery`)).toMatchObject({
      title: "Our storefront",
      description: "Your store's Deco Score",
    });
    const agent = await row(`commerce-discovery_${ORG_EDITED}`);
    expect(agent?.title).toBe("Shop assistant");
    expect(agent?.metadata).toBe(pinnedViews("Scorecard"));
  });

  it("renames the defaults from before the Report rename too", async () => {
    expect(await row(`${ORG_LEGACY}_commerce-discovery`)).toMatchObject({
      title: "Deco Score",
      description: "Your store's Deco Score",
    });
    const agent = await row(`commerce-discovery_${ORG_LEGACY}`);
    expect(agent).toMatchObject({
      title: "Deco Score Agent",
      description: "Ask anything about your store's Deco Score",
    });
    expect(JSON.parse(agent?.metadata ?? "{}").ui.pinnedViews[0].label).toBe(
      "Deco Score",
    );
  });

  it("skips metadata that never parsed", async () => {
    expect(await row(`commerce-discovery_${ORG_BROKEN}`)).toMatchObject({
      title: "Deco Score Agent",
      metadata: "{not json",
    });
  });

  it("down restores the old defaults", async () => {
    await down(database.db as never);
    expect((await row(`${ORG_DEFAULT}_commerce-discovery`))?.title).toBe(
      "Store Report",
    );
    const agent = await row(`commerce-discovery_${ORG_DEFAULT}`);
    expect(agent?.title).toBe("Report Agent");
    expect(JSON.parse(agent?.metadata ?? "{}")).toEqual(
      JSON.parse(pinnedViews("Report")),
    );
    expect((await row(`${ORG_EDITED}_commerce-discovery`))?.title).toBe(
      "Our storefront",
    );
    await up(database.db as never);
  });
});
