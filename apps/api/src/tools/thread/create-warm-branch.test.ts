import { describe, expect, test } from "bun:test";
import { AGENT_SANDBOX_KIND } from "../sandbox/sandbox-map";
import { pickWarmBranchFromSandboxMap } from "./create";

const agent = (createdAt: number) => ({ [AGENT_SANDBOX_KIND]: { createdAt } });

describe("pickWarmBranchFromSandboxMap", () => {
  test("picks the user's most recently touched branch", () => {
    expect(
      pickWarmBranchFromSandboxMap(
        { u1: { "sacci-old": agent(1), "sacci-new": agent(2) } },
        "u1",
      ),
    ).toBe("sacci-new");
  });

  /** A chat that names no branch (task board, home composer, MCP) is not Blog
   *  work, so it must not land on the Blog draft the user touched last. */
  test("never offers a Blog draft, however recent", () => {
    expect(
      pickWarmBranchFromSandboxMap(
        {
          u1: {
            "sacci-site": agent(1),
            "blog-draft-sacci-abc": agent(9),
          },
        },
        "u1",
      ),
    ).toBe("sacci-site");
    expect(
      pickWarmBranchFromSandboxMap(
        { u1: { "blog-draft-sacci-abc": agent(9) } },
        "u1",
      ),
    ).toBeUndefined();
  });

  test("nothing for another user or an empty map", () => {
    expect(
      pickWarmBranchFromSandboxMap({ u1: { a: agent(1) } }, "u2"),
    ).toBeUndefined();
    expect(pickWarmBranchFromSandboxMap(undefined, "u1")).toBeUndefined();
  });
});
