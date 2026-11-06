import { describe, expect, test } from "bun:test";
import {
  type ProductionGateInput,
  resolveProductionGate,
} from "./production-gate";

/** A v7 Fast Preview session on the default branch. */
const onProduction: ProductionGateInput = {
  runtime: "cms",
  runtimeResolved: true,
  siteMajor: "v7",
  localPreview: false,
  tunnelUndecided: false,
  servingLocally: false,
  branch: "main",
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

  test("opens a draft", () => {
    expect(
      resolveProductionGate({ ...onProduction, branch: "ana-1730000000" }),
    ).toBe("open");
  });

  test.each([
    ["a coding (sandbox) session", { runtime: "sandbox" }],
    [
      "a Blocks v8 site, whose base branch holds a CDN draft",
      { siteMajor: "v8" },
    ],
    ["a site whose schema couldn't be read", { siteMajor: "error" }],
    ["Local mode, which never saves", { localPreview: true }],
    ["a connected deco serve", { servingLocally: true }],
    ["no branch yet", { branch: null }],
    [
      "a default branch that couldn't be read (the API still refuses)",
      { defaultBranch: null },
    ],
  ] as const)("opens %s", (_, overrides) => {
    expect(resolveProductionGate({ ...onProduction, ...overrides })).toBe(
      "open",
    );
  });

  test.each([
    ["the runtime is unresolved", { runtimeResolved: false }],
    ["the site's major is loading", { siteMajor: "loading" }],
    ["the default branch is unknown", { defaultBranch: undefined }],
    ["a saved tunnel is undecided", { tunnelUndecided: true }],
  ] as const)("waits while %s", (_, overrides) => {
    expect(resolveProductionGate({ ...onProduction, ...overrides })).toBe(
      "pending",
    );
  });
});
