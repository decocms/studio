import { describe, expect, test } from "bun:test";
import { projectsByConnection } from "./connection-projects.tsx";

const project = (id: string, connectionIds: string[]) =>
  ({
    id,
    title: id,
    connections: connectionIds.map((connection_id) => ({
      connection_id,
      selected_tools: null,
      selected_resources: null,
      selected_prompts: null,
    })),
  }) as never;

describe("projectsByConnection", () => {
  test("lists every project aggregating a connection", () => {
    const map = projectsByConnection([
      project("farm", ["conn_ga4", "conn_vtex"]),
      project("animale", ["conn_ga4"]),
    ]);
    expect(map.get("conn_ga4")?.map((p) => p.id)).toEqual(["farm", "animale"]);
    expect(map.get("conn_vtex")?.map((p) => p.id)).toEqual(["farm"]);
  });

  test("a connection nothing aggregates is absent, not empty", () => {
    const map = projectsByConnection([project("farm", [])]);
    expect(map.get("conn_ga4")).toBeUndefined();
  });

  test("a project with no connections array does not throw", () => {
    const map = projectsByConnection([{ id: "x", title: "x" } as never]);
    expect(map.size).toBe(0);
  });
});
