import { describe, expect, test } from "bun:test";
import {
  type ProductionGateInput,
  resolveProductionGate,
} from "./production-gate";

/** A v7 Fast Preview session on the default branch. */
const onProduction: ProductionGateInput = {
  runtime: "cms",
  runtimeResolved: true,
  blocksV8: false,
  localPreview: false,
  servingLocally: false,
  branch: "main",
  listedDraft: false,
  defaultBranch: "main",
};

describe("resolveProductionGate", () => {
  test("blocks a v7 Fast Preview session on the default branch", () => {
    expect(resolveProductionGate(onProduction)).toBe("blocked");
  });

  test("blocks whatever the default branch is called", () => {
    expect(
      resolveProductionGate({
        ...onProduction,
        branch: "master",
        defaultBranch: "master",
      }),
    ).toBe("blocked");
  });

  test("blocks production even when a draft entry names it", () => {
    expect(resolveProductionGate({ ...onProduction, listedDraft: true })).toBe(
      "blocked",
    );
  });

  test("opens a draft", () => {
    expect(
      resolveProductionGate({ ...onProduction, branch: "ana-1730000000" }),
    ).toBe("open");
  });

  test("opens a listed draft without waiting for the default branch", () => {
    expect(
      resolveProductionGate({
        ...onProduction,
        branch: "ana-1730000000",
        listedDraft: true,
        defaultBranch: undefined,
      }),
    ).toBe("open");
  });

  test.each([
    ["a coding (sandbox) session", { runtime: "sandbox" }],
    [
      "a Blocks v8 site, whose base branch holds a CDN draft",
      { blocksV8: true },
    ],
    ["Local mode, which never saves", { localPreview: true }],
    ["a connected deco serve", { servingLocally: true }],
    [
      "a default branch that couldn't be read (the API still refuses)",
      { defaultBranch: null },
    ],
  ] as const)("opens %s", (_, overrides) => {
    expect(resolveProductionGate({ ...onProduction, ...overrides })).toBe(
      "open",
    );
  });

  test("opens a session without a branch outside the CMS", () => {
    expect(
      resolveProductionGate({
        ...onProduction,
        runtime: "sandbox",
        branch: null,
      }),
    ).toBe("open");
  });

  test.each([
    ["the runtime is unresolved", { runtimeResolved: false }],
    ["a CMS session's branch hasn't landed", { branch: null }],
    ["the default branch is unknown", { defaultBranch: undefined }],
  ] as const)("waits while %s", (_, overrides) => {
    expect(resolveProductionGate({ ...onProduction, ...overrides })).toBe(
      "pending",
    );
  });
});
