import { describe, expect, test } from "bun:test";
import { en } from "@/i18n/en/index.ts";
import { ptBR } from "@/i18n/pt-br/index.ts";
import {
  BIND_PROVIDER_COPY,
  PROVIDER_BY_BINDING_TYPE,
  remediationFor,
} from "./sa-binding-copy.ts";

const PROVIDERS = ["ga4", "gsc"] as const;

/** Every reason the commerce-discovery bind endpoint can return, plus an
 *  unknown one to prove the fallback. */
const REASONS = [
  "no-access",
  "no-web-stream",
  "no-match",
  "resource_already_bound",
  "something-new",
];

describe("PROVIDER_BY_BINDING_TYPE", () => {
  test("maps only the two Google companions to provider codes", () => {
    expect(PROVIDER_BY_BINDING_TYPE["google-analytics"]).toBe("ga4");
    expect(PROVIDER_BY_BINDING_TYPE["google-search-console"]).toBe("gsc");
    expect(PROVIDER_BY_BINDING_TYPE.vtex).toBeUndefined();
  });
});

describe("BIND_PROVIDER_COPY", () => {
  test("console deep links point at the product the steps describe", () => {
    expect(BIND_PROVIDER_COPY.ga4.consoleUrl).toContain("analytics.google.com");
    expect(BIND_PROVIDER_COPY.gsc.consoleUrl).toContain("search-console");
  });

  test("the steps tell the user to paste the SA e-mail", () => {
    for (const provider of PROVIDERS) {
      const steps = BIND_PROVIDER_COPY[provider].steps;
      expect(steps).toHaveLength(3);
      expect(steps.map((k) => en[k]).join(" ")).toContain("paste this e-mail");
    }
  });

  test("every key resolves in both dictionaries", () => {
    for (const provider of PROVIDERS) {
      const copy = BIND_PROVIDER_COPY[provider];
      const keys = [
        copy.consoleLinkKey,
        copy.resourceLabelKey,
        copy.resourcePlaceholderKey,
        copy.resourceHintKey,
        ...copy.steps,
      ];
      for (const key of keys) {
        expect(en[key]?.length ?? 0).toBeGreaterThan(0);
        expect(ptBR[key]?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });
});

describe("remediationFor", () => {
  test("every reason resolves to a title plus at least one step, in both dictionaries", () => {
    for (const provider of PROVIDERS) {
      for (const reason of REASONS) {
        const r = remediationFor(provider, reason);
        expect(r.stepKeys.length).toBeGreaterThan(0);
        for (const key of [r.titleKey, ...r.stepKeys]) {
          expect(en[key]?.length ?? 0).toBeGreaterThan(0);
          expect(ptBR[key]?.length ?? 0).toBeGreaterThan(0);
        }
      }
    }
  });

  test("no-web-stream (site URL missing on GA) walks through adding a web stream", () => {
    const r = remediationFor("ga4", "no-web-stream");
    expect(en[r.titleKey]).toContain("web data stream");
    expect(r.stepKeys.map((k) => en[k]).join(" ")).toContain("Add stream");
  });

  test("no-access is provider-specific (GSC calls out the unusable permission)", () => {
    const ga4 = remediationFor("ga4", "no-access");
    const gsc = remediationFor("gsc", "no-access");
    expect(ga4.stepKeys).not.toEqual(gsc.stepKeys);
    // {email} is interpolated by the form, so the SA address has to be asked for
    // by the string rather than baked into it.
    expect(ga4.stepKeys.map((k) => en[k]).join(" ")).toContain("{email}");
    expect(gsc.stepKeys.map((k) => en[k]).join(" ")).toContain("Unverified");
  });

  test("resource_already_bound points to manual review", () => {
    const r = remediationFor("ga4", "resource_already_bound");
    expect(r.stepKeys.map((k) => en[k]).join(" ")).toContain("support");
  });

  test("unknown reason falls back to the generic remediation", () => {
    expect(remediationFor("gsc", "something-new").titleKey).toBe(
      "commerceOnboarding.saBinding.remediation.unknown.title",
    );
  });
});
