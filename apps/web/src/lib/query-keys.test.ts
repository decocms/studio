import { describe, expect, test } from "bun:test";
import { KEYS } from "./query-keys";

describe("KEYS.reportAll", () => {
  test("is a prefix of KEYS.report for every key/lang combination", () => {
    // `reportAll` is used to invalidate every `report` query for a domain in
    // one call (see reports/auth-gate.tsx's `onReportAuthenticated`) — it
    // only works if it's actually a prefix of every variant `report` mints.
    const domain = "example.com";
    const prefix = KEYS.reportAll(domain);
    const variants = [
      KEYS.report(domain),
      KEYS.report(domain, "preview-key"),
      KEYS.report(domain, undefined, "pt-BR"),
      KEYS.report(domain, "preview-key", "pt-BR"),
    ];
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
