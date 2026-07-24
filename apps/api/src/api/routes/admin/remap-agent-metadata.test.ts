import { describe, expect, test } from "bun:test";
import { remapAgentMetadata } from "./remap-agent-metadata";

const targets = (
  connections: Record<string, string> = {},
  secrets: Record<string, string> = {},
) => ({
  connections: new Map(Object.entries(connections)),
  secrets: new Map(Object.entries(secrets)),
});

describe("remapAgentMetadata", () => {
  test("keeps the system prompt and unknown keys untouched", () => {
    const { metadata } = remapAgentMetadata(
      {
        instructions: "<role>You are a helper</role>",
        enabled_plugins: ["p1"],
        somethingAddedLater: { nested: true },
      },
      targets(),
    );

    expect(metadata.instructions).toBe("<role>You are a helper</role>");
    expect(metadata.enabled_plugins).toEqual(["p1"]);
    expect(metadata.somethingAddedLater).toEqual({ nested: true });
  });

  test("drops org-bound keys and reports each one", () => {
    const { metadata, skipped } = remapAgentMetadata(
      {
        instructions: "keep me",
        sandboxMap: { user_1: { main: {} } },
        liveAgentId: "vir_live",
        siteSlug: "acme",
        productionUrl: "https://acme.com",
        knowledge: [{ id: "k1" }],
      },
      targets(),
    );

    for (const key of [
      "sandboxMap",
      "liveAgentId",
      "siteSlug",
      "productionUrl",
      "knowledge",
    ]) {
      expect(key in metadata).toBe(false);
      expect(skipped.some((s) => s.includes(key))).toBe(true);
    }
    expect(metadata.instructions).toBe("keep me");
  });

  test("does not report keys that were absent or already null", () => {
    const { skipped } = remapAgentMetadata(
      { instructions: null, siteSlug: null },
      targets(),
    );
    expect(skipped).toEqual([]);
  });

  test("remaps connection ids across pinned views, tiles, tabs and github", () => {
    const { metadata } = remapAgentMetadata(
      {
        githubRepo: {
          url: "https://github.com/a/b",
          owner: "a",
          name: "b",
          connectionId: "conn_old",
          installationId: 42,
        },
        ui: {
          pinnedViews: [
            { connectionId: "conn_old", toolName: "T", label: "View" },
          ],
          homeTile: { connectionId: "conn_old", resourceUri: "ui://x" },
          homeTiles: [{ connectionId: "conn_old", resourceUri: "ui://y" }],
          layout: {
            tabs: [
              {
                id: "t1",
                title: "Tab",
                view: { type: "ext-app", appId: "conn_old" },
              },
            ],
          },
        },
      },
      targets({ conn_old: "conn_new" }),
    );

    const ui = metadata.ui as Record<string, unknown>;
    const layout = ui.layout as Record<string, unknown>;
    expect((metadata.githubRepo as Record<string, unknown>).connectionId).toBe(
      "conn_new",
    );
    expect(
      (metadata.githubRepo as Record<string, unknown>).installationId,
    ).toBe(42);
    expect(
      (ui.pinnedViews as { connectionId: string }[])[0]!.connectionId,
    ).toBe("conn_new");
    expect((ui.homeTile as { connectionId: string }).connectionId).toBe(
      "conn_new",
    );
    expect((ui.homeTiles as { connectionId: string }[])[0]!.connectionId).toBe(
      "conn_new",
    );
    expect((layout.tabs as { view: { appId: string } }[])[0]!.view.appId).toBe(
      "conn_new",
    );
  });

  test("drops unresolvable ui entries instead of pointing them at nothing", () => {
    const { metadata, skipped } = remapAgentMetadata(
      {
        ui: {
          pinnedViews: [{ connectionId: "gone", toolName: "T", label: "View" }],
          homeTile: { connectionId: "gone", resourceUri: "ui://x" },
          homeTiles: [{ connectionId: "gone", resourceUri: "ui://y" }],
          layout: {
            tabs: [{ id: "t1", view: { type: "ext-app", appId: "gone" } }],
          },
        },
      },
      targets(),
    );

    const ui = metadata.ui as Record<string, unknown>;
    expect(ui.pinnedViews).toEqual([]);
    expect(ui.homeTile).toBeNull();
    expect(ui.homeTiles).toEqual([]);
    expect((ui.layout as Record<string, unknown>).tabs).toEqual([]);
    expect(skipped).toHaveLength(4);
  });

  test("strips github credentials when the connection did not travel", () => {
    const { metadata, skipped } = remapAgentMetadata(
      {
        githubRepo: {
          url: "https://github.com/a/b",
          owner: "a",
          name: "b",
          connectionId: "gone",
          installationId: 42,
        },
      },
      targets(),
    );

    const repo = metadata.githubRepo as Record<string, unknown>;
    expect(repo).toEqual({
      url: "https://github.com/a/b",
      owner: "a",
      name: "b",
    });
    expect(skipped.some((s) => s.includes("githubRepo"))).toBe(true);
  });

  test("remaps secret-backed env vars and keeps literal ones", () => {
    const { metadata, skipped } = remapAgentMetadata(
      {
        runtime: {
          selected: "bun",
          env: [
            { key: "PUBLIC", kind: "literal", value: "v" },
            { key: "TOKEN", kind: "secret", secretId: "sec_old" },
            { key: "ORPHAN", kind: "secret", secretId: "sec_gone" },
          ],
          submoduleCredentials: [
            { host: "github.com", secretId: "sec_old" },
            { host: "gitlab.com", secretId: "sec_gone" },
          ],
        },
      },
      targets({}, { sec_old: "sec_new" }),
    );

    const runtime = metadata.runtime as Record<string, unknown>;
    expect(runtime.selected).toBe("bun");
    expect(runtime.env).toEqual([
      { key: "PUBLIC", kind: "literal", value: "v" },
      { key: "TOKEN", kind: "secret", secretId: "sec_new" },
    ]);
    expect(runtime.submoduleCredentials).toEqual([
      { host: "github.com", secretId: "sec_new" },
    ]);
    expect(skipped).toHaveLength(2);
  });

  test("remaps a pinned-view default but leaves a tab-id default alone", () => {
    const pinned = remapAgentMetadata(
      {
        ui: {
          layout: {
            defaultMainView: {
              type: "ext-apps",
              id: "conn_old",
              toolName: "T",
            },
          },
        },
      },
      targets({ conn_old: "conn_new" }),
    );
    expect(
      (
        (pinned.metadata.ui as Record<string, unknown>).layout as Record<
          string,
          unknown
        >
      ).defaultMainView,
    ).toEqual({ type: "ext-apps", id: "conn_new", toolName: "T" });

    // No toolName: `id` names a declared tab, not a connection — must not be touched.
    const tabDefault = remapAgentMetadata(
      {
        ui: {
          layout: {
            defaultMainView: { type: "ext-app", id: "analytics" },
            tabs: [{ id: "analytics", view: { type: "ext-app" } }],
          },
        },
      },
      targets(),
    );
    expect(
      (
        (tabDefault.metadata.ui as Record<string, unknown>).layout as Record<
          string,
          unknown
        >
      ).defaultMainView,
    ).toEqual({ type: "ext-app", id: "analytics" });
    expect(tabDefault.skipped).toEqual([]);

    // A system tab default must survive untouched too.
    const preview = remapAgentMetadata(
      { ui: { layout: { defaultMainView: { type: "preview" } } } },
      targets(),
    );
    expect(
      (
        (preview.metadata.ui as Record<string, unknown>).layout as Record<
          string,
          unknown
        >
      ).defaultMainView,
    ).toEqual({ type: "preview" });
  });

  test("resets a pinned-view default whose connection did not travel", () => {
    const { metadata, skipped } = remapAgentMetadata(
      {
        ui: {
          layout: {
            defaultMainView: { type: "ext-apps", id: "gone", toolName: "T" },
          },
        },
      },
      targets(),
    );
    expect(
      (
        (metadata.ui as Record<string, unknown>).layout as Record<
          string,
          unknown
        >
      ).defaultMainView,
    ).toBeNull();
    expect(skipped.some((s) => s.includes("defaultMainView"))).toBe(true);
  });

  test("narrows subAgents to what travelled and warns when nothing did", () => {
    const partial = remapAgentMetadata(
      { subAgents: ["conn_old", "vir_source_agent"] },
      targets({ conn_old: "conn_new" }),
    );
    expect(partial.metadata.subAgents).toEqual(["conn_new"]);
    expect(partial.skipped).toHaveLength(1);

    // Empty is preserved: dropping the field would mean "all org targets",
    // silently widening what the copy can delegate to.
    const none = remapAgentMetadata({ subAgents: ["vir_a"] }, targets());
    expect(none.metadata.subAgents).toEqual([]);
    expect(
      none.skipped.some((s) => s.includes("only delegate to itself")),
    ).toBe(true);
  });

  test("null metadata yields an empty object", () => {
    expect(remapAgentMetadata(null, targets())).toEqual({
      metadata: {},
      skipped: [],
    });
  });
});
