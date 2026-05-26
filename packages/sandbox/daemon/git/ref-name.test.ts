import { describe, expect, it } from "bun:test";
import {
  assertValidRemoteBranchName,
  InvalidRemoteBranchNameError,
} from "./ref-name";

describe("assertValidRemoteBranchName", () => {
  it("accepts common branch names", () => {
    expect(() => assertValidRemoteBranchName("main")).not.toThrow();
    expect(() => assertValidRemoteBranchName("feat/shipping")).not.toThrow();
    expect(() => assertValidRemoteBranchName("release-1.0")).not.toThrow();
  });

  it("rejects git flag injection and unsafe refs", () => {
    for (const name of [
      "",
      "--upload-pack=evil",
      "-p",
      "main..other",
      "/main",
      "main/",
      "main.lock",
      "has space",
    ]) {
      expect(() => assertValidRemoteBranchName(name)).toThrow(
        InvalidRemoteBranchNameError,
      );
    }
  });
});
