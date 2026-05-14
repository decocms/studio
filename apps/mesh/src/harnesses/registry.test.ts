import { describe, expect, test } from "bun:test";
import type { HarnessFactory, HarnessId } from "./types";
import {
  getHarnessFactory,
  registerHarnessFactory,
  resetRegistryForTests,
} from "./registry";

const makeFactoryStub = (id: HarnessId): HarnessFactory => ({
  id,
  create: () => ({
    id,
    // biome-ignore lint/correctness/useYield: stub
    async *stream() {},
  }),
});

describe("harness registry", () => {
  test("getHarnessFactory returns undefined for unknown id", () => {
    resetRegistryForTests();
    expect(getHarnessFactory("decopilot")).toBeUndefined();
  });

  test("registerHarnessFactory stores and getHarnessFactory retrieves", () => {
    resetRegistryForTests();
    const stub = makeFactoryStub("decopilot");
    registerHarnessFactory(stub);
    expect(getHarnessFactory("decopilot")).toBe(stub);
  });

  test("re-registering the same id overwrites", () => {
    resetRegistryForTests();
    const first = makeFactoryStub("claude-code");
    const second = makeFactoryStub("claude-code");
    registerHarnessFactory(first);
    registerHarnessFactory(second);
    expect(getHarnessFactory("claude-code")).toBe(second);
  });
});
