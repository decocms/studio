import { describe, expect, test } from "bun:test";
import {
  projectForReportSite,
  projectReportConnectionId,
} from "./use-project-reports.ts";

const project = (id: string, storeUrl: string | null) =>
  ({
    id,
    title: id,
    metadata: { instructions: null, project: { kind: "site", storeUrl } },
  }) as never;

describe("projectForReportSite", () => {
  test("matches on host, ignoring scheme, www and path", () => {
    const projects = [
      project("a", "https://animale.com.br"),
      project("b", "farm.com.br"),
    ];
    expect(
      projectForReportSite(projects, "https://www.farm.com.br/feminino")?.id,
    ).toBe("b");
  });

  test("is null when no project claims the site", () => {
    expect(
      projectForReportSite([project("a", "animale.com.br")], "farm.com.br"),
    ).toBe(null);
  });

  test("is null when the diagnostic names no site", () => {
    expect(projectForReportSite([project("a", "farm.com.br")], null)).toBe(
      null,
    );
  });

  test("a project with no store URL never claims a report", () => {
    expect(projectForReportSite([project("a", null)], "farm.com.br")).toBe(
      null,
    );
  });
});

describe("projectReportConnectionId", () => {
  test("falls back to the org's well-known reports connection", () => {
    expect(projectReportConnectionId("org_1", { metadata: {} })).toContain(
      "org_1",
    );
  });

  test("a per-project pointer wins", () => {
    expect(
      projectReportConnectionId("org_1", {
        metadata: { project: { reportConnectionId: "conn_abc" } },
      }),
    ).toBe("conn_abc");
  });
});
