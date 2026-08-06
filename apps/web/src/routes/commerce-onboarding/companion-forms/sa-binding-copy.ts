// Structure + translation keys for the shared-SA binding flow (the consent-free
// lane). Pure data/functions so the guidance is unit-testable and the form stays
// presentational. The whole point: tell the user EXACTLY what to do, both to
// grant access up front and to fix a specific failure (e.g. a GA4 property with
// no web data stream ⇒ no site URL to verify against).
//
// Every user-facing string lives in the i18n dictionaries; this module only
// names the keys (typed, so a missing translation is a compile error).

import type { TranslationKey } from "@/i18n/use-t.ts";

export type BindProvider = "ga4" | "gsc";

/** The shared service account the client grants access to, never a human
 *  account (no consent screen, no god-login to protect). */
export const SA_EMAIL = "deco-reader@decocms.iam.gserviceaccount.com";

/** commerce-discovery binding requirement types → provider codes. Only these
 *  two use the shared-SA lane; VTEX keeps its own credential flow. */
export const PROVIDER_BY_BINDING_TYPE: Record<string, BindProvider> = {
  "google-analytics": "ga4",
  "google-search-console": "gsc",
};

export interface BindProviderCopy {
  /** Human label, e.g. "Google Analytics". Product name, not translated. */
  label: string;
  /** Deep link to the console the steps describe. */
  consoleUrl: string;
  consoleLinkKey: TranslationKey;
  /** The three things to do, one short line each. */
  steps: readonly [TranslationKey, TranslationKey, TranslationKey];
  /** Field label / placeholder / hint for the id the user pastes. */
  resourceLabelKey: TranslationKey;
  resourcePlaceholderKey: TranslationKey;
  resourceHintKey: TranslationKey;
}

export const BIND_PROVIDER_COPY: Record<BindProvider, BindProviderCopy> = {
  ga4: {
    label: "Google Analytics",
    consoleUrl: "https://analytics.google.com/analytics/web/#/admin",
    consoleLinkKey: "commerceOnboarding.saBinding.ga4.openConsole",
    steps: [
      "commerceOnboarding.saBinding.ga4.step1",
      "commerceOnboarding.saBinding.ga4.step2",
      "commerceOnboarding.saBinding.ga4.step3",
    ],
    resourceLabelKey: "commerceOnboarding.saBinding.ga4.resourceLabel",
    resourcePlaceholderKey:
      "commerceOnboarding.saBinding.ga4.resourcePlaceholder",
    resourceHintKey: "commerceOnboarding.saBinding.ga4.resourceHint",
  },
  gsc: {
    label: "Google Search Console",
    consoleUrl: "https://search.google.com/search-console",
    consoleLinkKey: "commerceOnboarding.saBinding.gsc.openConsole",
    steps: [
      "commerceOnboarding.saBinding.gsc.step1",
      "commerceOnboarding.saBinding.gsc.step2",
      "commerceOnboarding.saBinding.gsc.step3",
    ],
    resourceLabelKey: "commerceOnboarding.saBinding.gsc.resourceLabel",
    resourcePlaceholderKey:
      "commerceOnboarding.saBinding.gsc.resourcePlaceholder",
    resourceHintKey: "commerceOnboarding.saBinding.gsc.resourceHint",
  },
};

export interface RemediationCopy {
  titleKey: TranslationKey;
  stepKeys: readonly TranslationKey[];
}

/**
 * Map a bind failure `reason` to concrete, provider-specific next steps. The
 * backend already returns a one-line pt-BR `detail`; this turns each failure
 * into an actionable checklist the form renders inline. `no-web-stream` is the
 * "site URL missing on GA" case: the property has no web data stream to verify
 * the domain against, so we walk the user through creating one.
 */
export function remediationFor(
  provider: BindProvider,
  reason: string,
): RemediationCopy {
  switch (reason) {
    case "no-access":
      return {
        titleKey: "commerceOnboarding.saBinding.remediation.noAccess.title",
        stepKeys:
          provider === "ga4"
            ? [
                "commerceOnboarding.saBinding.remediation.noAccess.ga4.1",
                "commerceOnboarding.saBinding.remediation.noAccess.ga4.2",
                "commerceOnboarding.saBinding.remediation.noAccess.ga4.3",
              ]
            : [
                "commerceOnboarding.saBinding.remediation.noAccess.gsc.1",
                "commerceOnboarding.saBinding.remediation.noAccess.gsc.2",
                "commerceOnboarding.saBinding.remediation.noAccess.gsc.3",
              ],
      };
    case "no-web-stream":
      // GA4-specific: the property measures no website, so there's no defaultUri
      // (site URL) to check ownership against.
      return {
        titleKey: "commerceOnboarding.saBinding.remediation.noWebStream.title",
        stepKeys: [
          "commerceOnboarding.saBinding.remediation.noWebStream.1",
          "commerceOnboarding.saBinding.remediation.noWebStream.2",
          "commerceOnboarding.saBinding.remediation.noWebStream.3",
          "commerceOnboarding.saBinding.remediation.noWebStream.4",
        ],
      };
    case "no-match":
      return {
        titleKey: "commerceOnboarding.saBinding.remediation.noMatch.title",
        stepKeys:
          provider === "ga4"
            ? [
                "commerceOnboarding.saBinding.remediation.noMatch.ga4.1",
                "commerceOnboarding.saBinding.remediation.noMatch.ga4.2",
              ]
            : [
                "commerceOnboarding.saBinding.remediation.noMatch.gsc.1",
                "commerceOnboarding.saBinding.remediation.noMatch.gsc.2",
              ],
      };
    case "resource_already_bound":
      return {
        titleKey: "commerceOnboarding.saBinding.remediation.alreadyBound.title",
        stepKeys: [
          "commerceOnboarding.saBinding.remediation.alreadyBound.1",
          "commerceOnboarding.saBinding.remediation.alreadyBound.2",
        ],
      };
    default:
      return {
        titleKey: "commerceOnboarding.saBinding.remediation.unknown.title",
        stepKeys: [
          "commerceOnboarding.saBinding.remediation.unknown.1",
          "commerceOnboarding.saBinding.remediation.unknown.2",
        ],
      };
  }
}
