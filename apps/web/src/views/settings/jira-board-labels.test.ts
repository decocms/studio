import { describe, expect, it } from "bun:test";
import {
  boardLabels,
  boardSearchFilter,
  boardSearchText,
} from "./jira-board-labels";

describe("boardLabels", () => {
  it("leads with the project, because that is what Jira's own UI shows", () => {
    // A team-managed project: Jira auto-named the board "OS board" and shows
    // the project name in its board header, so the board name alone is useless.
    expect(
      boardLabels({
        id: 1,
        name: "OS board",
        projectKey: "OS",
        projectName: "Acme <> Example | Squad Sites",
      }),
    ).toEqual({
      primary: "Acme <> Example | Squad Sites",
      secondary: "OS board · OS",
    });
  });

  it("keeps the board name visible so sibling boards stay distinguishable", () => {
    const project = { projectKey: "ABC", projectName: "Example Project" };
    const demands = boardLabels({ id: 2, name: "Demands", ...project });
    const epics = boardLabels({ id: 3, name: "Epics", ...project });
    expect(demands.primary).toBe(epics.primary);
    expect(demands.secondary).not.toBe(epics.secondary);
  });

  it("falls back to the board name when Jira reports no project", () => {
    expect(boardLabels({ id: 4, name: "Standalone board" })).toEqual({
      primary: "Standalone board",
      secondary: "",
    });
  });

  it("collapses the whitespace people type into project names", () => {
    expect(
      boardLabels({ id: 5, name: " b ", projectName: "Two  spaces   here " })
        .primary,
    ).toBe("Two spaces here");
  });
});

describe("boardSearchText", () => {
  it("stays unique for same-named boards in different projects", () => {
    const a = boardSearchText({
      id: 10,
      name: "03. Tasks",
      projectName: "Project A",
    });
    const b = boardSearchText({
      id: 11,
      name: "03. Tasks",
      projectName: "Project B",
    });
    expect(a).not.toBe(b);
  });

  it("stays unique even when project AND board name collide", () => {
    const same = { name: "Board", projectName: "Project" };
    expect(boardSearchText({ id: 12, ...same })).not.toBe(
      boardSearchText({ id: 13, ...same }),
    );
  });
});

describe("boardSearchFilter", () => {
  const label = "Acme <> Example | Squad Sites OS board · OS #1610";

  it("matches a substring, ignoring case", () => {
    expect(boardSearchFilter(label, "squad")).toBe(1);
    expect(boardSearchFilter(label, "SQUAD")).toBe(1);
  });

  it("requires every term, in any order", () => {
    expect(boardSearchFilter(label, "sites squad")).toBe(1);
    expect(boardSearchFilter(label, "squad missing")).toBe(0);
  });

  it("ignores accents, which nobody types", () => {
    expect(boardSearchFilter("01. Épicos · Análise", "epicos")).toBe(1);
    expect(boardSearchFilter("01. Épicos · Análise", "analise")).toBe(1);
  });

  it("finds a board by id", () => {
    expect(boardSearchFilter(label, "1610")).toBe(1);
  });

  it("keeps everything when the search is empty or blank", () => {
    expect(boardSearchFilter(label, "")).toBe(1);
    expect(boardSearchFilter(label, "   ")).toBe(1);
  });

  it("rejects a subsequence, which is what the fuzzy default got wrong", () => {
    // "sites" must not match "Custo Médio - Protheus | 01. Épicos" just because
    // those letters appear scattered across it.
    expect(
      boardSearchFilter("Custo Medio - Protheus | 01. Epicos", "sites"),
    ).toBe(0);
  });
});
