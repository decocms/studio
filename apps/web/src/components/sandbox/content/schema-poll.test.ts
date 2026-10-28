import { describe, expect, it } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { hasEditableAppEditorSchema } from "./app-editor-schema";
import {
  liveMetaSchemaPollInterval,
  SCHEMA_POLL_INTERVAL_MS,
  SCHEMA_POLL_MAX_READS,
  type SchemaPollWindow,
} from "./schema-poll";

const INSTALLED = "site/apps/deco/blog.ts";

/** A meta that predates the install: the app's module is not in it. */
const beforeInstall: LiveMeta = {
  manifest: { blocks: { apps: { "site/apps/site.ts": {} } } },
  schema: { definitions: {} },
};

const afterInstall: LiveMeta = {
  manifest: {
    blocks: {
      apps: { "site/apps/site.ts": {}, [INSTALLED]: { $ref: "#/x" } },
    },
  },
  schema: { definitions: {} },
};

/** One call with no wait carried in — the first read of a fresh selection. */
const first = (input: {
  resolveType: string | undefined;
  meta: LiveMeta | undefined;
  reads?: number;
}) =>
  liveMetaSchemaPollInterval({
    reads: 0,
    window: null,
    ...input,
  });

/**
 * The caller's loop: carry the wait from one call into the next, as the ref in
 * `content-browser` does.
 */
function poller() {
  let window: SchemaPollWindow | null = null;
  return (
    resolveType: string | undefined,
    meta: LiveMeta | undefined,
    reads: number,
  ) => {
    const decision = liveMetaSchemaPollInterval({
      resolveType,
      meta,
      reads,
      window,
    });
    window = decision.window;
    return decision.interval;
  };
}

describe("liveMetaSchemaPollInterval", () => {
  it("keeps re-reading while the app is missing from the manifest", () => {
    expect(
      first({ resolveType: INSTALLED, meta: beforeInstall }).interval,
    ).toBe(SCHEMA_POLL_INTERVAL_MS);
  });

  it("stops once the app reaches the manifest", () => {
    const decision = first({ resolveType: INSTALLED, meta: afterInstall });
    expect(decision.interval).toBeFalse();
    expect(decision.window).toBeNull();
  });

  it("re-reads before the first meta arrives", () => {
    expect(first({ resolveType: INSTALLED, meta: undefined }).interval).toBe(
      SCHEMA_POLL_INTERVAL_MS,
    );
  });

  it("is not fooled by the site-wide schema standing in for the app's", () => {
    // A block the manifest doesn't carry resolves against the global schema,
    // whose fields belong to no app in particular. "Has editable fields" alone
    // would stop here and render that form as if it were the app's.
    const withGlobalFields: LiveMeta = {
      ...beforeInstall,
      schema: { properties: { title: { type: "string" } }, definitions: {} },
    };
    expect(hasEditableAppEditorSchema(INSTALLED, withGlobalFields)).toBeTrue();
    expect(
      first({ resolveType: INSTALLED, meta: withGlobalFields }).interval,
    ).toBe(SCHEMA_POLL_INTERVAL_MS);
  });

  it("waits for nothing when nothing is selected", () => {
    expect(
      first({ resolveType: undefined, meta: beforeInstall }).interval,
    ).toBeFalse();
  });

  it("waits for nothing when the block carries no resolveType", () => {
    expect(
      first({ resolveType: "", meta: beforeInstall }).interval,
    ).toBeFalse();
  });

  it("gives up once the budget is spent", () => {
    const poll = poller();
    // The query is not new: a long editing session has already read many times,
    // and the budget still has to be a full one.
    expect(poll(INSTALLED, beforeInstall, 500)).toBe(SCHEMA_POLL_INTERVAL_MS);
    expect(
      poll(INSTALLED, beforeInstall, 500 + SCHEMA_POLL_MAX_READS - 1),
    ).toBe(SCHEMA_POLL_INTERVAL_MS);
    expect(
      poll(INSTALLED, beforeInstall, 500 + SCHEMA_POLL_MAX_READS),
    ).toBeFalse();
  });

  it("gives a newly selected block its own budget", () => {
    const poll = poller();
    poll(INSTALLED, beforeInstall, 0);
    expect(poll(INSTALLED, beforeInstall, SCHEMA_POLL_MAX_READS)).toBeFalse();
    expect(
      poll("site/apps/deco/other.ts", beforeInstall, SCHEMA_POLL_MAX_READS),
    ).toBe(SCHEMA_POLL_INTERVAL_MS);
  });

  it("reopens the budget after the schema arrives and is lost again", () => {
    const poll = poller();
    poll(INSTALLED, beforeInstall, 0);
    expect(poll(INSTALLED, afterInstall, 1)).toBeFalse();
    // A later restart drops it from the manifest again: a new wait, not the
    // tail end of the old one.
    expect(poll(INSTALLED, beforeInstall, 1 + SCHEMA_POLL_MAX_READS)).toBe(
      SCHEMA_POLL_INTERVAL_MS,
    );
  });
});
