import { describe, expect, it } from "bun:test";
import {
  findSprintFieldIds,
  parseSprintRefs,
  pickIssueSprint,
  stripOrderBy,
} from "./sprint-field";

describe("findSprintFieldIds", () => {
  it("finds Sprint by its schema, not by its name", () => {
    // A team can rename the field, and any custom field can be called "Sprint".
    expect(
      findSprintFieldIds([
        { id: "customfield_10010", schema: { custom: "…:gh-lexo-rank" } },
        { id: "customfield_10020", schema: { custom: "…" } },
        {
          id: "customfield_10030",
          schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
        },
      ]),
    ).toEqual(["customfield_10030"]);
  });

  /** Cloud gives every team-managed project its own Sprint field, so taking
   *  only the first reports "no sprint" for every card driven by another. */
  it("returns every Sprint field, not just the first", () => {
    const sprintField = (id: string) => ({
      id,
      schema: { custom: "com.pyxis.greenhopper.jira:gh-sprint" },
    });
    expect(
      findSprintFieldIds([
        sprintField("customfield_10020"),
        { id: "summary" },
        sprintField("customfield_10105"),
      ]),
    ).toEqual(["customfield_10020", "customfield_10105"]);
  });

  it("is empty on a site with no Agile fields", () => {
    expect(findSprintFieldIds([{ id: "summary" }])).toEqual([]);
    expect(findSprintFieldIds([])).toEqual([]);
  });
});

describe("parseSprintRefs", () => {
  it("reads Cloud's sprint objects, numeric ids included", () => {
    expect(
      parseSprintRefs([
        {
          id: 42,
          name: "Sprint 12",
          state: "ACTIVE",
          startDate: "2026-03-02T09:00:00.000Z",
          endDate: "2026-03-15T09:00:00.000Z",
        },
      ]),
    ).toEqual([
      {
        id: "42",
        name: "Sprint 12",
        state: "active",
        startsAt: new Date("2026-03-02T09:00:00.000Z"),
        endsAt: new Date("2026-03-15T09:00:00.000Z"),
      },
    ]);
  });

  it("drops Jira Server's stringified sprints instead of scraping them", () => {
    // Scraping the format would invent a sprint on a customer's board.
    expect(
      parseSprintRefs([
        "com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=7,state=ACTIVE,name=Sprint 7]",
      ]),
    ).toEqual([]);
  });

  it("is empty for every non-list value the field can hold", () => {
    for (const value of [null, undefined, "", 0, {}]) {
      expect(parseSprintRefs(value)).toEqual([]);
    }
  });

  it("skips entries with no usable id", () => {
    expect(
      parseSprintRefs([{ name: "no id" }, { id: "" }, null, { id: 3 }]),
    ).toHaveLength(1);
  });

  it("falls back to a name and to `future` rather than dropping the sprint", () => {
    const [ref] = parseSprintRefs([{ id: 9, state: "PLANNED" }]);
    expect(ref?.name).toBe("Sprint 9");
    expect(ref?.state).toBe("future");
  });

  it("reads an unparseable or absent date as no date", () => {
    const [ref] = parseSprintRefs([
      { id: 9, name: "S", state: "closed", startDate: "nope" },
    ]);
    expect(ref?.startsAt).toBe(null);
    expect(ref?.endsAt).toBe(null);
  });
});

describe("pickIssueSprint", () => {
  const ref = (
    id: string,
    state: "active" | "future" | "closed",
    startsAt: string | null = null,
  ) => ({
    id,
    name: `Sprint ${id}`,
    state,
    startsAt: startsAt ? new Date(startsAt) : null,
    endsAt: null,
  });

  it("prefers the running sprint over a closed one it was carried out of", () => {
    // A carried-over issue lists BOTH, and Jira sends the running one FIRST.
    expect(
      pickIssueSprint([
        ref("2674", "active", "2026-08-25T00:00:00.000Z"),
        ref("2673", "closed", "2026-08-10T00:00:00.000Z"),
      ])?.id,
    ).toBe("2674");
    expect(
      pickIssueSprint([
        ref("2673", "closed", "2026-08-10T00:00:00.000Z"),
        ref("2674", "active", "2026-08-25T00:00:00.000Z"),
      ])?.id,
    ).toBe("2674");
  });

  /** Real shape from a board that had carried one issue through four sprints:
   *  `[Sprint 2, Sprint 3, Sprint 1, Sprint 2]`. Reading the LAST entry would
   *  have labelled the card with the second-oldest sprint of the four. */
  it("picks the latest closed sprint by date, not by array position", () => {
    expect(
      pickIssueSprint([
        ref("2607", "closed", "2026-07-24T00:00:00.000Z"),
        ref("2673", "closed", "2026-08-10T00:00:00.000Z"),
        ref("2508", "closed", "2026-07-08T00:00:00.000Z"),
        ref("2640", "closed", "2026-07-24T00:00:00.000Z"),
      ])?.id,
    ).toBe("2673");
  });

  it("falls back to the sprint id when Jira sends no dates", () => {
    // Ids are handed out in creation order, so the larger one is the later.
    expect(
      pickIssueSprint([ref("12", "active"), ref("13", "active")])?.id,
    ).toBe("13");
    expect(
      pickIssueSprint([ref("13", "active"), ref("12", "active")])?.id,
    ).toBe("13");
  });

  it("prefers a dated sprint to one Jira never scheduled", () => {
    expect(
      pickIssueSprint([
        ref("99", "future"),
        ref("13", "future", "2026-09-07T00:00:00.000Z"),
      ])?.id,
    ).toBe("13");
  });

  it("prefers a running sprint to a planned one", () => {
    expect(
      pickIssueSprint([
        ref("13", "future", "2026-09-07T00:00:00.000Z"),
        ref("12", "active", "2026-08-25T00:00:00.000Z"),
      ])?.id,
    ).toBe("12");
  });

  it("keeps a card whose only sprint has closed in that sprint", () => {
    expect(
      pickIssueSprint([
        ref("10", "closed", "2026-06-01T00:00:00.000Z"),
        ref("11", "closed", "2026-06-15T00:00:00.000Z"),
      ])?.id,
    ).toBe("11");
  });

  it("is null for an issue in no sprint — the backlog", () => {
    expect(pickIssueSprint([])).toBe(null);
  });
});

describe("stripOrderBy", () => {
  it("drops the trailing clause a saved filter always carries", () => {
    expect(stripOrderBy('project = "OS" ORDER BY Rank ASC')).toBe(
      'project = "OS"',
    );
    expect(stripOrderBy("project = OS order by rank")).toBe("project = OS");
    expect(stripOrderBy("project = OS ORDER  BY Rank")).toBe("project = OS");
  });

  it("leaves a filter with no ordering alone", () => {
    expect(stripOrderBy("project = OS AND labels = web")).toBe(
      "project = OS AND labels = web",
    );
    expect(stripOrderBy("")).toBe("");
  });

  it("does not cut inside a quoted search term", () => {
    // Cutting here would silently change which issues sync.
    expect(stripOrderBy('summary ~ "order by rank"')).toBe(
      'summary ~ "order by rank"',
    );
    expect(stripOrderBy("summary ~ 'order by rank' ORDER BY Rank")).toBe(
      "summary ~ 'order by rank'",
    );
  });

  it("cuts at the last ordering, not the first mention", () => {
    expect(stripOrderBy('summary ~ "order by" AND x = 1 ORDER BY Rank')).toBe(
      'summary ~ "order by" AND x = 1',
    );
  });

  it("is not fooled by an escaped quote inside a term", () => {
    expect(stripOrderBy('summary ~ "a \\" order by b" ORDER BY Rank')).toBe(
      'summary ~ "a \\" order by b"',
    );
  });
});
