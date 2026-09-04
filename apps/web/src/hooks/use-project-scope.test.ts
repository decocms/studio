import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  MIN_PROJECTS_FOR_SWITCHER,
  projectForScope,
  resolveProjectScopeId,
  scopableProjects,
} from "./use-project-scope";

function project(
  id: string,
  metadata: Record<string, unknown> = {},
): VirtualMCPEntity {
  return {
    id,
    title: id,
    metadata,
  } as unknown as VirtualMCPEntity;
}

describe("scopableProjects", () => {
  test("keeps ordinary projects", () => {
    const projects = [project("vir_a"), project("vir_b")];
    expect(scopableProjects(projects).map((p) => p.id)).toEqual([
      "vir_a",
      "vir_b",
    ]);
  });

  /** The Super Agent is the org-wide default, not something you scope TO. */
  test("drops Decopilot", () => {
    const projects = [project("vir_a"), project("decopilot_org_1")];
    expect(scopableProjects(projects).map((p) => p.id)).toEqual(["vir_a"]);
  });

  /**
   * A dev agent is reached through the Develop/Live toggle on its live
   * counterpart. The old sidebar leaked repo-backed ones into the list because
   * its two membership predicates disagreed; one predicate, one answer.
   */
  test("drops dev agents", () => {
    const projects = [
      project("vir_live"),
      project("vir_dev", { liveAgentId: "vir_live" }),
    ];
    expect(scopableProjects(projects).map((p) => p.id)).toEqual(["vir_live"]);
  });

  test("tolerates null", () => {
    expect(scopableProjects(null)).toEqual([]);
    expect(scopableProjects(undefined)).toEqual([]);
  });
});

describe("projectForScope", () => {
  test("resolves a routed dev project without offering it in the picker", () => {
    const live = project("vir_live");
    const dev = project("vir_dev", { liveAgentId: live.id });
    const all = [live, dev];

    expect(scopableProjects(all)).toEqual([live]);
    expect(projectForScope(all, dev.id, null)).toBe(dev);
  });

  test("resolves an exact routed project beyond the picker page", () => {
    const listed = project("vir_listed");
    const exact = project("vir_unlisted", { liveAgentId: listed.id });

    expect(projectForScope([listed], exact.id, exact)).toBe(exact);
  });

  test("ignores an exact result for a different route identity", () => {
    expect(projectForScope([], "vir_current", project("vir_stale"))).toBeNull();
  });
});

describe("MIN_PROJECTS_FOR_SWITCHER", () => {
  /** Regression: this was 2, on the reasoning that a scope over a single
   *  project narrows nothing. True, but the control is also the ONLY route to a
   *  project's workspace now that per-project rows are gone — so a
   *  single-project org lost all access to Preview, Code and Content. It must
   *  render from the first project. */
  test("is one, so a single-project org can still reach its workspace", () => {
    expect(MIN_PROJECTS_FOR_SWITCHER).toBe(1);
  });
});

describe("resolveProjectScopeId", () => {
  test("canonical path identity wins over the legacy search input", () => {
    expect(
      resolveProjectScopeId({
        agentIdParam: "vir_path",
        legacyVirtualMcpId: "vir_search",
      }),
    ).toBe("vir_path");
  });

  test("reads the retired search key only on the legacy thread route", () => {
    expect(
      resolveProjectScopeId({
        legacyVirtualMcpId: "vir_legacy",
        legacyThreadRoute: true,
      }),
    ).toBe("vir_legacy");
  });

  test("ignores stale query identity on canonical organization pages", () => {
    expect(
      resolveProjectScopeId({ legacyVirtualMcpId: "vir_stale" }),
    ).toBeNull();
  });

  test("normalizes missing and blank identities to no scope", () => {
    expect(resolveProjectScopeId({})).toBeNull();
    expect(resolveProjectScopeId({ legacyVirtualMcpId: "  " })).toBeNull();
  });
});
