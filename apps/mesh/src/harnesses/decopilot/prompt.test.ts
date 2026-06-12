import { describe, expect, test } from "bun:test";
import * as promptModule from "./prompt";

describe("prompt module surface", () => {
  test("listAgentsBlock is removed (agents now pre-resolved as data)", () => {
    expect("listAgentsBlock" in promptModule).toBe(false);
  });
});
