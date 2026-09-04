import { describe, expect, it } from "bun:test";
import {
  isMainBreadcrumbScopeCurrent,
  resolveMainBreadcrumbAncestorPresentation,
  resolveMainBreadcrumbAncestorTrail,
} from "./trail";

interface TestItem {
  id: string;
  label: string;
  destination: string;
}

function item(id: string, label = id, destination = `/${id}`): TestItem {
  return { id, label, destination };
}

describe("isMainBreadcrumbScopeCurrent", () => {
  it("collapses only the same semantic destination", () => {
    expect(
      isMainBreadcrumbScopeCurrent(
        item("organization:1", "Home"),
        item("organization:1", "Home"),
      ),
    ).toBe(true);
    expect(
      isMainBreadcrumbScopeCurrent(
        item("organization:1", "Home"),
        item("route:home-dashboard", "Home"),
      ),
    ).toBe(false);
  });
});

describe("resolveMainBreadcrumbAncestorTrail", () => {
  it("keeps distinct semantic ancestors even when labels match", () => {
    const project = item("project:1", "Site Editor", "/agents/1");

    expect(
      resolveMainBreadcrumbAncestorTrail(
        "organization:1",
        [project],
        "site-editor",
      ),
    ).toEqual({ all: [project], nearest: project, overflow: [] });
  });

  it("excludes scope and current identities", () => {
    const settings = item("settings");

    expect(
      resolveMainBreadcrumbAncestorTrail(
        "organization:1",
        [
          item("organization:1", "Duplicate scope"),
          settings,
          item("members", "Duplicate current"),
        ],
        "members",
      ),
    ).toEqual({ all: [settings], nearest: settings, overflow: [] });
  });

  it("keeps order and separates the nearest ancestor from overflow", () => {
    const settings = item("settings");
    const storage = item("storage");
    const buckets = item("buckets");

    expect(
      resolveMainBreadcrumbAncestorTrail(
        "organization:1",
        [settings, storage, buckets],
        "bucket:1",
      ),
    ).toEqual({
      all: [settings, storage, buckets],
      nearest: buckets,
      overflow: [settings, storage],
    });
  });

  it("uses the innermost duplicate id consistently in every presentation", () => {
    const outerProject = item("project:1", "Old title", "/old-project");
    const settings = item("settings");
    const innerProject = item("project:1", "Current title", "/agents/1");

    const trail = resolveMainBreadcrumbAncestorTrail(
      "organization:1",
      [outerProject, settings, innerProject],
      "site-editor",
    );

    expect(trail).toEqual({
      all: [settings, innerProject],
      nearest: innerProject,
      overflow: [settings],
    });
    expect(trail.all.at(-1)).toBe(trail.nearest);
  });

  it("returns an empty presentation without ancestors", () => {
    expect(
      resolveMainBreadcrumbAncestorTrail(
        "organization:1",
        [],
        "organization-home",
      ),
    ).toEqual({ all: [], nearest: undefined, overflow: [] });
  });
});

describe("resolveMainBreadcrumbAncestorPresentation", () => {
  it("makes a route contribution nearest and keeps every static parent navigable", () => {
    const settings = item("settings");
    const connections = item("connections");

    expect(
      resolveMainBreadcrumbAncestorPresentation(
        "organization:1",
        [settings, connections],
        "tool:run",
        true,
      ),
    ).toEqual({ inline: undefined, overflow: [settings, connections] });
    expect(
      resolveMainBreadcrumbAncestorPresentation(
        "organization:1",
        [settings, connections],
        "tool:run",
        false,
      ),
    ).toEqual({ inline: connections, overflow: [settings] });
  });
});
