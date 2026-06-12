import { describe, expect, it } from "bun:test";
import { assertBunRuntime, isBunRuntime } from "./outbox-runtime";

describe("outbox-runtime guard", () => {
  it("reports Bun present when process.versions.bun is set", () => {
    expect(isBunRuntime({ bun: "1.3.14" })).toBe(true);
  });

  it("reports Bun absent for a plain Node versions object", () => {
    expect(isBunRuntime({ node: "22.0.0" })).toBe(false);
  });

  it("assertBunRuntime throws a loud, actionable error under non-Bun", () => {
    expect(() => assertBunRuntime({ node: "22.0.0" })).toThrow(
      /durable outbox requires the Bun runtime/,
    );
  });

  it("assertBunRuntime is a no-op under Bun", () => {
    expect(() => assertBunRuntime({ bun: "1.3.14" })).not.toThrow();
  });
});
