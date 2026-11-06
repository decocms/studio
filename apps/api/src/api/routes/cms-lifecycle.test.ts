/**
 * Condition 1 of the design: no GitHub call in any content operation. The
 * whole lifecycle — site setup (schema push), opening the editor, saving, a
 * conflict, undo, publish, history, rollback, draft list and discard — runs
 * through the hosted CMS routes with every function of `@/git-providers`
 * (and the repo-content readers) set to throw.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";

const gitCalls: string[] = [];

const realModules: Array<[string, Record<string, unknown>]> = [];

/** The module with every function replaced by one that records and throws. */
async function throwingModule(path: string) {
  const real = (await import(path)) as Record<string, unknown>;
  realModules.push([path, { ...real }]);
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(real)) {
    const isClass =
      typeof value === "function" &&
      /^class[\s{]/.test(Function.prototype.toString.call(value));
    out[name] =
      typeof value === "function" && !isClass
        ? (..._args: unknown[]) => {
            gitCalls.push(`${path}.${name}`);
            throw new Error(`GitHub is off in this test: ${path}.${name}`);
          }
        : value;
  }
  return out;
}

const gitProviders = await throwingModule("@/git-providers");
const readDecofile = await throwingModule("@/decofile/read-decofile");
mock.module("@/git-providers", () => gitProviders);
mock.module("@/decofile/read-decofile", () => readDecofile);

const { cmsTestApp } = await import("./cms-test-app");
const { SCHEMA_TEXT } = await import("@/hosted/hosted-test-helpers");
const { blockVersion } = await import("@/hosted/block-version");
const { clearRevisionCache } = await import("@/hosted/cms-release");

beforeAll(() => clearRevisionCache());
afterAll(() => {
  for (const [path, real] of realModules) mock.module(path, () => real);
});

describe("the hosted CMS lifecycle with GitHub off", () => {
  it("runs end to end without one GitHub call", async () => {
    const t = cmsTestApp();
    const draft = "threads/t-42";

    // Site setup: CI pushes the schema.
    expect(
      (await t.call("PUT", "acme/schema", undefined, SCHEMA_TEXT)).status,
    ).toBe(200);

    // Opening the editor: its draft, the form schema, the blocks.
    const opened = await t.call("POST", "acme/drafts", { name: draft });
    expect(opened.status).toBe(200);
    expect(
      (await t.rpc("acme", draft, "schema.get")).body.result.schema,
    ).toBeTruthy();
    expect(
      (await t.rpc("acme", draft, "blocks.list")).body.result.blocks,
    ).toEqual({});

    // Ana saves; Bob, on a stale copy, gets a conflict naming Ana.
    t.as({ userId: "usr_ana", method: "session" });
    const saved = await t.rpc("acme", draft, "blocks.apply", {
      set: { header: { title: "Black Friday" }, footer: { t: 1 } },
      ifMatch: { header: null, footer: null },
    });
    expect(saved.body.result.versions.header).toBe(
      blockVersion({ title: "Black Friday" }),
    );
    t.as({ userId: "usr_bob", method: "mcpOAuth" });
    const conflict = await t.rpc("acme", draft, "blocks.apply", {
      set: { header: { title: "Mine" } },
      ifMatch: { header: null },
    });
    expect(conflict.body.error.code).toBe(-32002);
    expect(conflict.body.error.data.draft.header).toMatchObject({
      block: { title: "Black Friday" },
      editor: { userId: "usr_ana" },
    });

    // Undo a block (changes.discard), then publish.
    const listed = await t.rpc("acme", draft, "changes.list");
    expect(Object.keys(listed.body.result.changes).sort()).toEqual([
      "footer",
      "header",
    ]);
    expect(
      (await t.rpc("acme", draft, "changes.discard", { names: ["footer"] }))
        .body.error,
    ).toBeUndefined();
    const published = await t.call(
      "POST",
      `acme/drafts/${encodeURIComponent(draft)}/publish`,
      {
        message: "Black Friday",
      },
    );
    expect(published.body).toMatchObject({
      result: "published",
      previous: null,
      draftEmptied: true,
    });
    const first = published.body.revision as string;

    // A second publish, then history and a rollback to the first.
    await t.rpc("acme", draft, "blocks.apply", {
      set: { header: { title: "Cyber Monday" } },
      ifMatch: { header: null },
    });
    const second = await t.call(
      "POST",
      `acme/drafts/${encodeURIComponent(draft)}/publish`,
      {},
    );
    expect(second.body).toMatchObject({ result: "published", previous: first });
    const releases = await t.call("GET", "acme/releases");
    expect(
      releases.body.revisions.map((r: { status: string }) => r.status),
    ).toEqual(["current", "listed"]);
    expect(releases.body.revisions[0].meta).toMatchObject({
      via: "cli",
      author: "usr_bob",
    });
    const rolled = await t.call("POST", `acme/releases/${first}/rollback`, {});
    expect(rolled.body).toMatchObject({
      result: "published",
      previous: second.body.revision,
    });
    expect(
      (await t.rpc("acme", draft, "blocks.list")).body.result.blocks,
    ).toEqual({
      header: { title: "Black Friday" },
    });

    // Drafts list and discard.
    expect((await t.call("GET", "acme/drafts")).body.drafts).toHaveLength(1);
    expect(
      (await t.call("DELETE", `acme/drafts/${encodeURIComponent(draft)}`))
        .status,
    ).toBe(200);
    expect((await t.call("GET", "acme/drafts")).body.drafts).toHaveLength(0);

    expect(gitCalls).toEqual([]);
  });
});
