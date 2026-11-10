import { describe, expect, test } from "bun:test";
import {
  appToolLabel,
  isScreenAppTool,
  screenAppsFirst,
} from "./screen-app-tools";

describe("screen app tools", () => {
  test("recognizes the APP_ prefix in either case", () => {
    expect(isScreenAppTool("APP_PROJETOS")).toBe(true);
    expect(isScreenAppTool("app_timeline")).toBe(true);
    expect(isScreenAppTool("APP_")).toBe(false);
    expect(isScreenAppTool("APPLY_DISCOUNT")).toBe(false);
    expect(isScreenAppTool("show_chart")).toBe(false);
  });

  test("labels drop the prefix unless the tool has a title", () => {
    expect(appToolLabel({ name: "APP_PROJETOS" })).toBe("Projetos");
    expect(appToolLabel({ name: "app_vet_team" })).toBe("Vet Team");
    expect(appToolLabel({ name: "APP_X", title: "Board" })).toBe("Board");
    expect(appToolLabel({ name: "show_chart" })).toBe("Show Chart");
  });

  test("puts screen apps first and keeps the rest in order", () => {
    const names = screenAppsFirst([
      { name: "b_chart" },
      { name: "APP_TWO" },
      { name: "a_table" },
      { name: "app_one" },
    ]).map((t) => t.name);
    expect(names).toEqual(["APP_TWO", "app_one", "b_chart", "a_table"]);
  });
});
