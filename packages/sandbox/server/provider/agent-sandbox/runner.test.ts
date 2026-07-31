import { describe, expect, it } from "bun:test";
import type { EnsureOptions } from "../types";
import { stripEnsureOpts } from "./runner";

describe("stripEnsureOpts", () => {
  it("retains orgFsConfigJson so resurrection replays org-fs mounts", () => {
    const opts: EnsureOptions = { orgFsConfigJson: '{"mounts":[]}' };
    expect(stripEnsureOpts(opts)).toEqual({ orgFsConfigJson: '{"mounts":[]}' });
  });

  it("drops orgFsConfigJson along with everything else when unset", () => {
    expect(stripEnsureOpts({})).toBeNull();
  });
});
