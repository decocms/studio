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
import { useT } from "@/i18n/use-t.ts";
import { ReportSocialProof } from "./report-social-proof";
import {
  beginReportAuthAttempt,
  captureReport,
  reportAuthAttemptProperties,
  reportAuthErrorType,
  updateReportAuthAttempt,
} from "./track";
import { DECK } from "./templates/tokens";

/** The deck is a fixed-light "paper" surface (see `DECK` above) regardless of
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

function callbackUrl(domain: string): string {
  const path = `/report/${encodeURIComponent(domain)}`;
  if (typeof window === "undefined") return path;
  return `${path}${window.location.search}${window.location.hash}`;
}

// Mock findings mirroring the deck cover's clickable TOC.
// Initialized in component to use translation context
const getBackdropFindings = (t: ReturnType<typeof useT>): readonly string[] => [
  t("reports.authGate.finding1"),
  t("reports.authGate.finding2"),
  t("reports.authGate.finding3"),
  t("reports.authGate.finding4"),
  t("reports.authGate.finding5"),
];

const BACKDROP_SCORE = 72;

/** A blurred, non-interactive stand-in for the real Signal Deck (see
 *  `signal-deck.tsx` + `cover-template.tsx`): the translucent header pill,
 *  the holographic cover card (score ring + headline + findings on the left,
 *  a rainbow art panel with a browser preview on the right), the side progress
 *  rail, and the footer bar. It's a mock, but it reads as the same product —
 *  just wider — so the auth gate sits on the report it unlocks. */
export function ReportBackdrop({ domain }: { domain: string }) {
  const t = useT();
  const ringSize = 104;
  const ringW = 10;
  const r = (ringSize - ringW) / 2;
  const circumference = 2 * Math.PI * r;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-[-18px] flex select-none flex-col overflow-hidden"
      style={{
        background: DECK.bg,
        color: DECK.ink,
        filter: "blur(9px)",
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        transform: "scale(1.025)",
      }}
    >
      {/* header — rounded translucent pill bar with the deco logo + Share */}
      <div className="shrink-0 px-6 pt-6 sm:px-10">
        <div
          className="mx-auto flex h-[60px] max-w-[1440px] items-center gap-3 rounded-full border pl-6 pr-4"
          style={{
            borderColor: DECK.cardBorder,
            background: "rgba(255,255,255,0.82)",
            boxShadow:
              "0 1px 2px rgba(40,37,36,0.05), 0 10px 30px -20px rgba(40,37,36,0.35)",
          }}
        >
          <img
            src="/logos/deco-logo.svg"
            alt=""
            width={54}
            height={22}
            className="h-[22px] w-auto"
          />
          <span
            className="ml-auto flex h-9 w-24 items-center justify-center rounded-full text-sm font-medium"
            style={{ background: DECK.primary, color: DECK.primaryFg }}
          >
            {t("reports.authGate.share")}
          </span>
        </div>
      </div>

      {/* stage — the cover card */}
      <div className="relative min-h-0 flex-1 px-6 py-8 sm:px-10">
        <div
          className="mx-auto flex h-full w-full max-w-[1280px] flex-col overflow-hidden rounded-[26px]"
          style={{
            background:
              "radial-gradient(120% 80% at 30% 0%, #ffffff 0%, #fafaf9 45%, #f6f4f1 100%)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 0 0 1px rgba(40,37,36,0.05), 0 1px 2px rgba(40,37,36,0.04)",
          }}
        >
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-2">
            {/* left: favicon header + score + headline + findings */}
            <div className="flex min-h-0 flex-col px-5 py-5">
              <div
                className="flex shrink-0 items-center gap-3 pb-4"
                style={{ borderBottom: `1px solid ${DECK.border}` }}
              >
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white"
                  style={{ border: `1px solid ${DECK.border}` }}
                >
                  <img
                    src={faviconForDomain(domain)}
                    alt=""
                    className="h-full w-full object-contain p-1.5"
                  />
                </div>
                <span className="min-w-0 flex-1 truncate text-base">
                  <span style={{ color: DECK.faint }}>https://</span>
                  {domain}
                </span>
                <span
                  className="shrink-0 text-[11px] font-medium uppercase tracking-[0.04em]"
                  style={{ color: DECK.soft }}
                >
                  {t("reports.authGate.report")}
                </span>
              </div>

              {/* Deco Score — static ring + number */}
              <div className="mt-4 flex shrink-0 items-center gap-5">
                <svg
                  width={ringSize}
                  height={ringSize}
                  className="-rotate-90 shrink-0"
                >
                  <circle
                    cx={ringSize / 2}
                    cy={ringSize / 2}
                    r={r}
                    fill="none"
                    stroke={DECK.border}
                    strokeWidth={ringW}
                  />
                  <circle
                    cx={ringSize / 2}
                    cy={ringSize / 2}
                    r={r}
                    fill="none"
                    stroke={DECK.soft}
                    strokeWidth={ringW}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={
                      circumference * (1 - BACKDROP_SCORE / 100)
                    }
                  />
                </svg>
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-baseline gap-2">
                    <span
                      className="text-[4rem] font-light leading-[0.9] tracking-[-0.02em] tabular-nums"
                      style={{ color: DECK.soft }}
                    >
                      {BACKDROP_SCORE}
                    </span>
                    <span className="text-xl" style={{ color: DECK.faint }}>
                      / 100
                    </span>
                  </div>
                  <span
                    className="text-[12px] font-medium uppercase tracking-[0.04em]"
                    style={{ color: DECK.soft }}
                  >
                    {t("reports.authGate.decoScore")}
                  </span>
                </div>
              </div>

              <h1
                className="mt-4 max-w-[24ch] text-[1.7rem] font-normal leading-[1.16] tracking-[-0.02em]"
                style={{ color: DECK.ink }}
              >
                {t("reports.authGate.headline")}
              </h1>

              <ul className="mt-auto flex flex-col pt-4">
                {getBackdropFindings(t).map((title, i) => (
                  <li
                    key={i}
                    style={
                      i < getBackdropFindings(t).length - 1
                        ? { borderBottom: `1px solid ${DECK.border}` }
                        : undefined
                    }
                  >
                    <div className="flex w-full items-center gap-3.5 py-2.5">
                      <span
                        className="shrink-0 text-[12px] tabular-nums"
                        style={{ color: DECK.soft }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-left text-[15px] opacity-55"
                        style={{ color: DECK.ink, lineHeight: 1.3 }}
                      >
                        {title}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>

            {/* right: holographic art panel with a browser preview */}
            <div className="hidden lg:block">
              <div
                className="relative h-full w-full overflow-hidden rounded-2xl"
                style={{
                  background:
                    "radial-gradient(circle at 18% 18%, rgba(208,236,26,.45), transparent 35%), radial-gradient(circle at 82% 30%, rgba(152,221,255,.7), transparent 34%), radial-gradient(circle at 60% 86%, rgba(255,183,214,.65), transparent 42%), #f7f5ef",
                }}
              >
                <div
                  className="absolute inset-x-8 top-8 rounded-2xl border bg-white p-3 shadow-xl"
                  style={{ borderColor: DECK.border }}
                >
                  <div
                    className="mb-3 flex items-center gap-2 border-b pb-3"
                    style={{ borderColor: DECK.border }}
                  >
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ff6b67]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#f5c451]" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#65c466]" />
                    <span
                      className="ml-3 h-6 flex-1 rounded-full"
                      style={{ background: DECK.bg }}
                    />
                  </div>
                  <div className="grid h-[330px] grid-cols-[0.72fr_1.28fr] gap-3">
                    <div
                      className="space-y-3 rounded-xl p-4"
                      style={{ background: DECK.forest }}
                    >
                      <div className="h-3 w-16 rounded-full bg-white/30" />
                      <div className="h-8 w-full rounded-lg bg-white/80" />
                      <div className="h-3 w-4/5 rounded-full bg-white/30" />
                      <div className="mt-8 h-24 rounded-xl bg-white/10" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {[0, 1, 2, 3].map((item) => (
                        <div
                          key={item}
                          className="rounded-xl border bg-white p-3"
                          style={{ borderColor: DECK.border }}
                        >
                          <div
                            className="h-24 rounded-lg"
                            style={{ background: DECK.bg }}
                          />
                          <div
                            className="mt-3 h-3 w-4/5 rounded-full"
                            style={{ background: DECK.border }}
                          />
                          <div
                            className="mt-2 h-3 w-1/2 rounded-full"
                            style={{ background: DECK.border }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* side progress rail */}
        <div className="absolute right-8 top-1/2 flex -translate-y-1/2 flex-col gap-1.5">
          {[0, 1, 2, 3, 4, 5].map((item) => (
            <span
              key={item}
              className="rounded-full"
              style={{
                height: item === 0 ? 3 : 2,
                width: item === 0 ? 28 : 12,
                background: item === 0 ? DECK.ink : "rgba(40,37,36,0.22)",
              }}
            />
          ))}
        </div>
      </div>

      {/* footer bar */}
      <footer
        className="flex shrink-0 items-center gap-2 px-6 py-4 sm:px-10"
        style={{ borderTop: `1px solid ${DECK.border}` }}
      >
        <span
          className="text-sm tabular-nums opacity-50"
          style={{ color: DECK.ink }}
        >
          01/06
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span
            className="flex h-12 items-center gap-2 rounded-full border px-6 text-sm font-medium"
            style={{
              borderColor: DECK.inputBorder,
              color: DECK.ink,
              background: DECK.surface,
            }}
          >
            {t("reports.authGate.shareButton")}
          </span>
          <span
            className="flex h-12 items-center rounded-full px-6 text-sm font-medium"
            style={{ background: DECK.primary, color: DECK.primaryFg }}
          >
            {t("reports.authGate.nextButton")}
          </span>
        </div>
      </footer>
    </div>
  );
}

/** The sign-in card itself — brand pill, `AuthEntry`, free-access note, social
 *  proof. Shared by the full-page `ReportAuthGate` and the in-deck
 *  `ReportAuthOverlay`, which differ only in what sits behind the card. */
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
      surface: "deck_v2",
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

  // The visitor is already sitting on this exact report page (full-page gate
  // or in-deck overlay) — no navigation needed to "unlock" the full deck,
  // just get the un-truncated data. Refetching by queryKey *prefix* (not the
  // full `KEYS.report(...)` tuple) matches regardless of the `key`/`lang`
  // suffix, so this works from either surface without threading those
  // through as props.
  const onReportAuthenticated = () =>
    queryClient.invalidateQueries({ queryKey: KEYS.reportAll(domain) });

  const trackGateRef = (element: HTMLDivElement | null) => {
    if (!element) return;
    const attempt = beginReportAuthAttempt(domain);
    if (element.dataset.tracked === "true" || !isPostHogInitialized()) return;
    element.dataset.tracked = "true";
    captureReport("report_auth_gate_shown", {
      domain,
      surface: "deck_v2",
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

export function ReportAuthGate({
  domain,
  loading = false,
}: {
  domain: string;
  loading?: boolean;
}) {
  const t = useT();
  return (
    <div
      className="fixed inset-0 overflow-hidden"
      style={{
        color: DECK.ink,
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <ReportBackdrop domain={domain} />
      <div className="pointer-events-none absolute inset-0 bg-white/55" />

      <div className="relative z-10 flex h-full items-center justify-center px-3 py-5 sm:px-6 sm:py-10">
        {loading ? (
          <div
            className="h-[330px] w-full max-w-[440px] animate-pulse rounded-3xl bg-white card-shadow"
            aria-label={t("reports.authGate.loadingSession")}
          />
        ) : (
          <ReportAuthCard domain={domain} />
        )}
      </div>
    </div>
  );
}

/** Shown over the real deck (cover slide still visible behind it) when an
 *  unauthenticated visitor tries to move past the cover. Unlike
 *  `ReportAuthGate`, there's no mock backdrop — the actual slide is already
 *  on screen. Clicking outside the card dismisses it back to the cover. */
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
