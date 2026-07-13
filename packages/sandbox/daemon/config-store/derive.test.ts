import { describe, expect, test } from "bun:test";
import { enrich } from "./derive";

describe("enrich runtimePathDirs", () => {
  test("bun runtime prepends /opt/bun/bin", () => {
    expect(
      enrich({ application: { runtime: "bun" } } as never).runtimePathDirs,
    ).toEqual(["/opt/bun/bin"]);
  });
  test("no runtime → empty", () => {
    expect(enrich({} as never).runtimePathDirs).toEqual([]);
  });
});
