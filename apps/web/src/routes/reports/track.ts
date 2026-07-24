import posthog from "posthog-js";
import type { CaptureOptions, Properties } from "posthog-js";
import { isPostHogInitialized } from "@/lib/posthog-client";

let reviewerMode = false;

const AUTH_ATTEMPT_PREFIX = "report:auth-attempt:";
const AUTH_ATTEMPT_TTL_MS = 60 * 60 * 1000;

export interface ReportAttribution {
  entrypoint: "direct" | "share" | "email" | "campaign";
  share_id?: string;
  email_run_id?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
}

export interface ReportAuthAttempt extends ReportAttribution {
  attempt_id: string;
  domain: string;
  gate_shown_at: number;
  method?: string;
  provider?: string;
  auth_mode?: "sign_in" | "sign_up";
}

export function reportAttributionFromSearch(search: string): ReportAttribution {
  const params = new URLSearchParams(search);
  const shareId = params.get("share_id") || undefined;
  const emailRunId = params.get("email_run_id") || undefined;
  const utmSource = params.get("utm_source") || undefined;
  const utmMedium = params.get("utm_medium") || undefined;
  const utmCampaign = params.get("utm_campaign") || undefined;
  const entrypoint =
    shareId || utmSource === "share"
      ? "share"
      : emailRunId || params.has("d") || utmSource === "email"
        ? "email"
        : utmSource
          ? "campaign"
          : "direct";

  return {
    entrypoint,
    ...(shareId ? { share_id: shareId } : {}),
    ...(emailRunId ? { email_run_id: emailRunId } : {}),
    ...(utmSource ? { utm_source: utmSource } : {}),
    ...(utmMedium ? { utm_medium: utmMedium } : {}),
    ...(utmCampaign ? { utm_campaign: utmCampaign } : {}),
  };
}

function currentReportAttribution(): ReportAttribution {
  return reportAttributionFromSearch(
    typeof window === "undefined" ? "" : window.location.search,
  );
}

function attemptKey(domain: string): string {
  return `${AUTH_ATTEMPT_PREFIX}${domain}`;
}

function newAttemptId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

function readReportAuthAttempt(domain: string): ReportAuthAttempt | null {
  try {
    const raw = window.sessionStorage.getItem(attemptKey(domain));
    if (!raw) return null;
    const attempt = JSON.parse(raw) as Partial<ReportAuthAttempt>;
    if (
      attempt.domain !== domain ||
      typeof attempt.attempt_id !== "string" ||
      typeof attempt.gate_shown_at !== "number" ||
      Date.now() - attempt.gate_shown_at > AUTH_ATTEMPT_TTL_MS
    ) {
      window.sessionStorage.removeItem(attemptKey(domain));
      return null;
    }
    return attempt as ReportAuthAttempt;
  } catch {
    return null;
  }
}

function writeReportAuthAttempt(attempt: ReportAuthAttempt): void {
  try {
    window.sessionStorage.setItem(
      attemptKey(attempt.domain),
      JSON.stringify(attempt),
    );
  } catch {
    // Analytics state must never interfere with authentication.
  }
}

/** Preserve one gated visit across OTP reloads and OAuth round-trips. */
export function beginReportAuthAttempt(domain: string): ReportAuthAttempt {
  const existing = readReportAuthAttempt(domain);
  if (existing) return existing;
  const attempt: ReportAuthAttempt = {
    attempt_id: newAttemptId(),
    domain,
    gate_shown_at: Date.now(),
    ...currentReportAttribution(),
  };
  writeReportAuthAttempt(attempt);
  return attempt;
}

export function updateReportAuthAttempt(
  domain: string,
  details: Pick<ReportAuthAttempt, "method" | "provider" | "auth_mode">,
): ReportAuthAttempt {
  const attempt = { ...beginReportAuthAttempt(domain), ...details };
  writeReportAuthAttempt(attempt);
  return attempt;
}

export function reportAuthAttemptProperties(attempt: ReportAuthAttempt) {
  return {
    auth_attempt_id: attempt.attempt_id,
    entrypoint: attempt.entrypoint,
    ...(attempt.share_id ? { share_id: attempt.share_id } : {}),
    ...(attempt.email_run_id ? { email_run_id: attempt.email_run_id } : {}),
    ...(attempt.utm_source ? { utm_source: attempt.utm_source } : {}),
    ...(attempt.utm_medium ? { utm_medium: attempt.utm_medium } : {}),
    ...(attempt.utm_campaign ? { utm_campaign: attempt.utm_campaign } : {}),
  };
}

export function consumeReportAuthAttempt(
  domain: string,
): ReportAuthAttempt | null {
  const attempt = readReportAuthAttempt(domain);
  if (!attempt) return null;
  try {
    window.sessionStorage.removeItem(attemptKey(domain));
  } catch {
    // The event can still be sent; at worst a later render de-dupes on its DOM.
  }
  return attempt;
}

export function reportAuthErrorType(error: string): string {
  const message = error.toLowerCase();
  if (message === "invalid_email") return "invalid_email";
  if (message.includes("429") || message.includes("rate limit"))
    return "rate_limited";
  if (
    message.includes("otp") ||
    message.includes("verification code") ||
    message.includes("invalid code") ||
    message.includes("expired code") ||
    message.includes("código") ||
    message.includes("codigo")
  )
    return "invalid_or_expired_code";
  if (message.includes("401") || message.includes("unauthorized"))
    return "invalid_credentials";
  if (message.includes("409") || message.includes("already exists"))
    return "account_exists";
  if (message.includes("network") || message.includes("fetch"))
    return "network";
  if (message.includes("cancel") || message.includes("closed"))
    return "cancelled";
  return "unknown";
}

/** Set at /report route render time (module state, so it lands before any
 *  child component captures — effects would run too late) and cleared on
 *  unmount. Reviewer sessions (?key=) flag every report event with
 *  `report_preview` instead of polluting the production funnel. */
export function setReportReviewerMode(on: boolean): void {
  reviewerMode = on;
}

/** posthog.capture for report-funnel events — merges attribution + reviewer flag.
 *  Direct posthog (not the `track` wrapper) because CTA clicks need
 *  `{transport: "sendBeacon"}`; the init-deferral guard is kept. */
export function captureReport(
  event: string,
  props?: Properties,
  options?: CaptureOptions,
): void {
  if (!isPostHogInitialized()) return;
  try {
    posthog.capture(
      event,
      {
        ...currentReportAttribution(),
        ...props,
        ...(reviewerMode ? { report_preview: "reviewer" } : {}),
      },
      options,
    );
  } catch {
    // Analytics must never affect report access or navigation.
  }
}
