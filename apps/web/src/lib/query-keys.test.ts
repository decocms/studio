import { describe, expect, test } from "bun:test";
import { KEYS } from "./query-keys";

describe("KEYS.reportAll", () => {
  test("is a prefix of KEYS.report for every lang", () => {
    // sign-in-overlay.tsx invalidates by this prefix, so it must match every variant.
    const domain = "example.com";
    const prefix = KEYS.reportAll(domain);
    const variants = [KEYS.report(domain), KEYS.report(domain, "pt-BR")];
    for (const variant of variants) {
      expect(variant.slice(0, prefix.length)).toEqual([...prefix]);
    }
  });

  test("does not match a different domain's report queries", () => {
    const prefix = KEYS.reportAll("example.com");
    const other = KEYS.report("other.com");
    expect(other.slice(0, prefix.length)).not.toEqual([...prefix]);
  });
});
