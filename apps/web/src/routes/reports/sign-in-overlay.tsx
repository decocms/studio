import type { CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AuthEntry } from "@/components/auth-entry";
import type {
  AuthFlowEvent,
  UnifiedAuthFormCopy,
} from "@/components/unified-auth-form";
import { faviconForDomain } from "@decocms/shared/report-seo";
import { isPostHogInitialized } from "@/lib/posthog-client";
import { KEYS } from "@/lib/query-keys";
import { callbackUrl } from "./callback-url";
import { useT } from "@/i18n/use-t.ts";
import { ReportSocialProof } from "./report-social-proof";
import {
  beginReportAuthAttempt,
  captureReport,
  REPORT_SURFACE,
  reportAuthAttemptProperties,
  reportAuthErrorType,
  updateReportAuthAttempt,
} from "./track";
import { DECK } from "./tokens";

/** The report screens are a fixed-light "paper" surface (see `DECK`) regardless of
 *  the app's dark mode, but `AuthEntry`/`UnifiedAuthForm` are shadcn
 *  components styled with the app's theme CSS variables, which still resolve
 *  to dark-mode values here (the `.dark` class lives on `<html>`, above this
 *  card). Pinning those variables to their light values keeps the card
 *  readable instead of rendering washed-out dark-mode buttons/inputs on a
 *  white card. Values mirror `:root` in `packages/ui/src/styles/global.css`. */
const FORCE_LIGHT_AUTH_VARS = {
  "--background": "oklch(0.99 0.003 73)",
  "--foreground": "oklch(0.145 0.01 60)",
  "--card": "oklch(1 0 0)",
  "--card-foreground": "oklch(0.145 0.01 60)",
  "--muted-foreground": "oklch(0.46 0.012 60)",
  "--accent": "oklch(0.955 0.008 80)",
  "--accent-foreground": "oklch(0.2 0.01 60)",
  "--border": "oklch(0.915 0.005 80)",
  "--input": "oklch(0.88 0.006 80)",
  "--ring": "oklch(0.205 0.012 60)",
  "--primary": "oklch(0.205 0.012 60)",
  "--primary-foreground": "oklch(0.98 0.005 60)",
  "--destructive": "oklch(0.58 0.22 27)",
  "--destructive-foreground": "oklch(0.97 0.01 17)",
  "--success": "oklch(0.6 0.17 149)",
  "--success-foreground": "oklch(0.98 0.02 156)",
} as CSSProperties;

function getReportAuthCopy(
  t: ReturnType<typeof useT>,
): Partial<UnifiedAuthFormCopy> {
  return {
    otpSendFailed: t("reports.authGate.otpSendFailed"),
    invalidCode: t("reports.authGate.invalidCode"),
    invalidEmail: t("reports.authGate.invalidEmail"),
    networkError: t("reports.authGate.networkError"),
    tooManyAttempts: t("reports.authGate.tooManyAttempts"),
    invalidOrExpiredCode: t("reports.authGate.invalidOrExpiredCode"),
    genericError: t("reports.authGate.genericError"),
    verificationCodeTitle: t("reports.authGate.verificationCodeTitle"),
    codeSentTo: (email: string) => t("reports.authGate.codeSentTo", { email }),
    continueWith: (provider: string) =>
      t("reports.authGate.continueWith", { provider }),
    divider: t("reports.authGate.divider"),
    emailLabel: t("reports.authGate.emailLabel"),
    emailPlaceholder: t("reports.authGate.emailPlaceholder"),
    sending: t("reports.authGate.sending"),
    sendCode: t("reports.authGate.sendCode"),
    verificationCodeLabel: t("reports.authGate.verificationCodeLabel"),
    enterCodePlaceholder: t("reports.authGate.enterCodePlaceholder"),
    verifying: t("reports.authGate.verifying"),
    verify: t("reports.authGate.verify"),
    useDifferentEmail: t("reports.authGate.useDifferentEmail"),
  };
}

/** The sign-in card itself — brand pill, `AuthEntry`, free-access note, social
 *  proof. */
function ReportAuthCard({ domain }: { domain: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const handleAuthEvent = (event: AuthFlowEvent) => {
    const provider = "provider" in event ? event.provider : undefined;
    const authMode = "mode" in event ? event.mode : undefined;
    const method =
      event.method === "social" ? (provider ?? "social") : event.method;
    const details = {
      method,
      provider,
      auth_mode: authMode,
    };
    const attempt = updateReportAuthAttempt(domain, details);

    const properties = {
      domain,
      surface: REPORT_SURFACE,
      ...reportAuthAttemptProperties(attempt),
      ...details,
    };

    if (event.type === "started") {
      captureReport("report_auth_started", properties);
    } else if (event.type === "otp_sent") {
      captureReport("report_auth_otp_sent", properties);
    } else if (event.type === "otp_submitted") {
      captureReport("report_auth_otp_submitted", properties);
    } else if (event.type === "failed") {
      captureReport("report_auth_failed", {
        ...properties,
        failure_stage: event.stage,
        error_type: reportAuthErrorType(event.error),
      });
    }
    // `succeeded` updates the durable attempt above. The identified success
    // event is emitted from `reports.tsx`'s `authCompletionRef` once
    // `authClient.useSession()` picks up the new cookie (no reload needed —
    // see `onAuthenticated` below).
  };

  // Sign in in place, so the scan poll behind the card keeps running.
  const onReportAuthenticated = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.reportAll(domain) });

  const trackGateRef = (element: HTMLDivElement | null) => {
    if (!element) return;
    const attempt = beginReportAuthAttempt(domain);
    if (element.dataset.tracked === "true" || !isPostHogInitialized()) return;
    element.dataset.tracked = "true";
    captureReport("report_auth_gate_shown", {
      domain,
      surface: REPORT_SURFACE,
      ...reportAuthAttemptProperties(attempt),
    });
  };

  return (
    <section
      ref={trackGateRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("reports.authGate.accessYourReport")}
      className="w-full max-w-[440px] rounded-2xl bg-white px-6 py-6 card-shadow sm:rounded-3xl sm:px-8 sm:py-8"
      style={FORCE_LIGHT_AUTH_VARS}
    >
      <AuthEntry
        callbackUrl={callbackUrl(domain)}
        title={t("reports.authGate.accessYourReport")}
        subtitle={t("reports.authGate.authSubtitle")}
        variant="compact"
        allowedSocialProviders={["google"]}
        allowPassword={false}
        onAuthEvent={handleAuthEvent}
        onAuthenticated={onReportAuthenticated}
        brand={
          <div className="flex items-center justify-between gap-4">
            <div
              className="inline-flex min-w-0 items-center gap-2 rounded-full border px-3 py-1.5"
              style={{ borderColor: DECK.border, background: DECK.bg }}
            >
              <img
                src={faviconForDomain(domain)}
                alt=""
                className="h-4 w-4 shrink-0 rounded object-contain"
              />
              <span
                className="truncate text-[13px]"
                style={{ color: DECK.muted }}
              >
                {domain}
              </span>
            </div>
            <img
              src="/logos/deco logo.svg"
              alt="Deco"
              className="h-7 w-7 shrink-0"
            />
          </div>
        }
        copy={getReportAuthCopy(t)}
      />
      <p className="mt-4 text-xs leading-5" style={{ color: DECK.faint }}>
        {t("reports.authGate.freeAccess")}
      </p>
      <ReportSocialProof compact />
    </section>
  );
}

/** The sign-in card over the scan screen, for an anonymous visitor who wants
 *  the finished report emailed. Clicking outside the card dismisses it. */
export function ReportAuthOverlay({
  domain,
  onClose,
}: {
  domain: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-3 py-5 sm:px-6 sm:py-10"
      style={{
        color: DECK.ink,
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-white/70 backdrop-blur-sm" />
      <div className="relative z-10" onClick={(e) => e.stopPropagation()}>
        <ReportAuthCard domain={domain} />
      </div>
    </div>
  );
}
