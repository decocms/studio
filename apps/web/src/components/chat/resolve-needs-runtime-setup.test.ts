import { describe, expect, it } from "bun:test";
import { resolveNeedsRuntimeSetup } from "./resolve-needs-runtime-setup";

const base = {
  isThreadLocked: false,
  hasCloudProviderKeys: false,
};

describe("resolveNeedsRuntimeSetup", () => {
  it("never gates a locked thread — its history must stay visible", () => {
    expect(resolveNeedsRuntimeSetup({ ...base, isThreadLocked: true })).toBe(
      false,
    );
    expect(
      resolveNeedsRuntimeSetup({
        ...base,
        isThreadLocked: true,
        hasCloudProviderKeys: true,
      }),
    ).toBe(false);
  });

  it("gates a fresh thread without a cloud provider key", () => {
    expect(resolveNeedsRuntimeSetup(base)).toBe(true);
  });

  it("releases a fresh thread once a cloud provider key exists", () => {
    expect(
      resolveNeedsRuntimeSetup({ ...base, hasCloudProviderKeys: true }),
    ).toBe(false);
  });
});
