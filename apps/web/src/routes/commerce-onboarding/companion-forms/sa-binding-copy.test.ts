import { describe, expect, test } from "bun:test";
import {
  BIND_PROVIDER_COPY,
  PROVIDER_BY_BINDING_TYPE,
  remediationFor,
  SA_EMAIL,
} from "./sa-binding-copy.ts";

describe("PROVIDER_BY_BINDING_TYPE", () => {
  test("maps only the two Google companions to provider codes", () => {
    expect(PROVIDER_BY_BINDING_TYPE["google-analytics"]).toBe("ga4");
    expect(PROVIDER_BY_BINDING_TYPE["google-search-console"]).toBe("gsc");
    expect(PROVIDER_BY_BINDING_TYPE.vtex).toBeUndefined();
  });
});

describe("connect steps always name the shared SA", () => {
  test("both providers instruct adding the SA email", () => {
    for (const provider of ["ga4", "gsc"] as const) {
      const joined = BIND_PROVIDER_COPY[provider].connectSteps.join(" ");
      expect(joined).toContain(SA_EMAIL);
    }
  });
});

describe("remediationFor", () => {
  test("no-web-stream (site URL missing on GA) walks through adding a web stream", () => {
    const r = remediationFor("ga4", "no-web-stream");
    expect(r.title).toContain("fluxo de dados da Web");
    expect(r.steps.join(" ")).toContain("Adicionar fluxo");
  });

  test("no-access is provider-specific (GSC calls out the unusable permission)", () => {
    expect(remediationFor("ga4", "no-access").steps.join(" ")).toContain(
      SA_EMAIL,
    );
    expect(remediationFor("gsc", "no-access").steps.join(" ")).toContain(
      "Não verificado",
    );
  });

  test("resource_already_bound points to manual review", () => {
    expect(
      remediationFor("ga4", "resource_already_bound").steps.join(" "),
    ).toContain("suporte");
  });

  test("unknown reason falls back to a safe generic remediation", () => {
    const r = remediationFor("gsc", "something-new");
    expect(r.title.length).toBeGreaterThan(0);
    expect(r.steps.length).toBeGreaterThan(0);
  });
});
