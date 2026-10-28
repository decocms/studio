import { describe, expect, it } from "bun:test";
import type { LiveMeta } from "@/components/sections-editor/resolve-schema";
import { hasEditableAppEditorSchema } from "./app-editor-schema";
import {
  liveMetaSchemaPollInterval,
  schemaPending,
  SCHEMA_POLL_INTERVAL_MS,
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

describe("liveMetaSchemaPollInterval", () => {
  it("keeps re-reading while the app is missing from the manifest", () => {
    expect(
      liveMetaSchemaPollInterval({
        resolveType: INSTALLED,
        meta: beforeInstall,
      }),
    ).toBe(SCHEMA_POLL_INTERVAL_MS);
  });

  it("stops once the app reaches the manifest", () => {
    expect(
      liveMetaSchemaPollInterval({
        resolveType: INSTALLED,
        meta: afterInstall,
      }),
    ).toBeFalse();
  });

  it("re-reads before the first meta arrives", () => {
    expect(
      liveMetaSchemaPollInterval({
        resolveType: INSTALLED,
        meta: undefined,
      }),
    ).toBe(SCHEMA_POLL_INTERVAL_MS);
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
      liveMetaSchemaPollInterval({
        resolveType: INSTALLED,
        meta: withGlobalFields,
      }),
    ).toBe(SCHEMA_POLL_INTERVAL_MS);
  });

  it("waits for nothing when nothing is selected", () => {
    expect(
      liveMetaSchemaPollInterval({
        resolveType: undefined,
        meta: beforeInstall,
      }),
    ).toBeFalse();
  });
});

describe("schemaPending", () => {
  const base = {
    resolveType: INSTALLED,
    metaLoading: false,
    metaFetching: false,
    podAlive: true,
  };

  it("waits through the restart that regenerates the schema", () => {
    // The dev server is DOWN for that restart. Reading it as "this app has no
    // schema" is what made the editor alternate between the spinner and "its
    // settings appear after a build" at the restart's own rhythm.
    expect(schemaPending({ ...base, meta: beforeInstall })).toBeTrue();
  });

  it("keeps waiting while a read is in flight", () => {
    expect(
      schemaPending({
        ...base,
        meta: beforeInstall,
        podAlive: false,
        metaFetching: true,
      }),
    ).toBeTrue();
  });

  it("says it plainly when no pod is coming", () => {
    // Fast Preview: nothing will ever build this app, so a spinner would lie.
    expect(
      schemaPending({ ...base, meta: beforeInstall, podAlive: false }),
    ).toBeFalse();
  });

  it("stops waiting for an app the manifest carries with nothing to edit", () => {
    expect(schemaPending({ ...base, meta: afterInstall })).toBeFalse();
  });
});
