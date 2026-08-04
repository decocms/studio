import { describe, expect, it } from "bun:test";
import type { EnsureOptions } from "../types";
import { stripEnsureOpts } from "./runner";

describe("stripEnsureOpts", () => {
  it("retains orgFsConfigJson so resurrection replays org-fs mounts", () => {
    const opts: EnsureOptions = { orgFsConfigJson: '{"mounts":[]}' };
    expect(stripEnsureOpts(opts)).toEqual({ orgFsConfigJson: '{"mounts":[]}' });
  });

  it("retains branch so resurrection recomputes the same handle", () => {
    const opts: EnsureOptions = {
      branch: "thread:thrd_1/conn_2",
      repo: {
        cloneUrl: "https://x",
        userName: "u",
        userEmail: "u@e",
        branch: "sandbox/thread-thrd_1-conn_2",
      },
    };
    expect(stripEnsureOpts(opts)?.branch).toBe("thread:thrd_1/conn_2");
  });

  it("drops orgFsConfigJson along with everything else when unset", () => {
    expect(stripEnsureOpts({})).toBeNull();
  });
});
