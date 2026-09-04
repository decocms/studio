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

describe("KEYS.commerceDiscoveryDiagnostic", () => {
  test("isolates organization and project report readers", () => {
    const organization = KEYS.commerceDiscoveryDiagnostic("org_1", "conn_1");
    const projectOne = KEYS.commerceDiscoveryDiagnostic(
      "org_1",
      "conn_1",
      "vir_1",
    );
    const projectTwo = KEYS.commerceDiscoveryDiagnostic(
      "org_1",
      "conn_1",
      "vir_2",
    );

    expect(organization).not.toEqual(projectOne);
    expect(projectOne).not.toEqual(projectTwo);
    expect(projectOne.at(-1)).toBe("vir_1");
  });

  test("shares one invalidation prefix across every ownership scope", () => {
    const prefix = KEYS.commerceDiscoveryDiagnosticPrefix("org_1", "conn_1");
    const variants = [
      KEYS.commerceDiscoveryDiagnostic("org_1", "conn_1"),
      KEYS.commerceDiscoveryDiagnostic("org_1", "conn_1", "vir_1"),
      KEYS.commerceDiscoveryDiagnostic("org_1", "conn_1", "vir_2"),
    ];

    for (const variant of variants) {
      expect(variant.slice(0, prefix.length)).toEqual([...prefix]);
    }
  });
});
