import { describe, expect, test } from "bun:test";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import {
  MIN_PROJECTS_FOR_SWITCHER,
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

  test("tolerates null", () => {
    expect(scopableProjects(null)).toEqual([]);
    expect(scopableProjects(undefined)).toEqual([]);
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
