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
 *  the cover card (headline + banded score on the light left page, the dark
 *  scan chamber with a browser preview and the chapter index on the right), the
 *  side progress rail, and the footer bar. It's a mock, but it reads as the same
 *  product — just wider — so the auth gate sits on the report it unlocks. */
export function ReportBackdrop({ domain }: { domain: string }) {
  const t = useT();

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
          <div className="flex min-h-0 flex-1 gap-2 p-2">
            {/* left: the editorial page — identity, verdict, banded score */}
            <div className="flex min-h-0 flex-col px-7 py-7 lg:w-[55%]">
              <div className="flex shrink-0 items-center gap-3">
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
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] font-medium leading-tight">
                    {domain}
                  </span>
                  <span
                    className="truncate text-[12px] leading-tight"
                    style={{ color: DECK.faint }}
                  >
                    {t("reports.authGate.report")}
                  </span>
                </div>
              </div>

              <h1
                className="mt-7 max-w-[20ch] text-[2.4rem] font-medium leading-[1.05] tracking-[-0.035em]"
                style={{ color: DECK.ink }}
              >
                {t("reports.authGate.headline")}
              </h1>

              {/* Deco Score — oversized number over a banded track */}
              <div className="mt-auto pt-8">
                <div className="flex items-end gap-3">
                  <span
                    className="text-[4.25rem] font-light leading-[0.82] tracking-[-0.045em] tabular-nums"
                    style={{ color: DECK.soft }}
                  >
                    {BACKDROP_SCORE}
                  </span>
                  <div className="flex flex-col gap-1.5 pb-1">
                    <span className="text-[13px]" style={{ color: DECK.faint }}>
                      / 100 · {t("reports.authGate.decoScore")}
                    </span>
                  </div>
                </div>
                <div
                  className="mt-4 h-1.5 w-full overflow-hidden rounded-full"
                  style={{ background: "rgba(40,37,36,0.08)" }}
                >
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${BACKDROP_SCORE}%`,
                      background: DECK.soft,
                    }}
                  />
                </div>
                <div
                  className="mt-6 flex gap-4 border-t pt-4"
                  style={{ borderColor: DECK.border }}
                >
                  {[62, 41, 78, 55, 33].map((value, i) => (
                    <div key={i} className="flex flex-1 flex-col gap-1.5">
                      <span
                        className="h-2 w-4/5 rounded-full"
                        style={{ background: DECK.border }}
                      />
                      <span
                        className="h-[3px] w-full overflow-hidden rounded-full"
                        style={{ background: "rgba(40,37,36,0.09)" }}
                      >
                        <span
                          className="block h-full rounded-full"
                          style={{ width: `${value}%`, background: DECK.soft }}
                        />
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* right: the dark scan chamber — browser preview + chapter index */}
            <div
              className="relative hidden min-h-0 flex-1 flex-col overflow-hidden rounded-2xl lg:flex"
              style={{
                background:
                  "radial-gradient(116% 88% at 82% 4%, rgba(208,236,26,0.18), transparent 56%), linear-gradient(158deg, #0a5122 0%, #07401a 44%, #052e11 100%)",
              }}
            >
              <div className="relative min-h-0 flex-1">
                <div className="absolute inset-x-7 top-7 overflow-hidden rounded-2xl bg-white">
                  <div
                    className="flex h-9 items-center gap-2 px-4"
                    style={{ background: "#f4f2ec" }}
                  >
                    <span className="h-2.5 w-2.5 rounded-full bg-black/15" />
                    <span className="h-2.5 w-2.5 rounded-full bg-black/15" />
                    <span className="h-2.5 w-2.5 rounded-full bg-black/15" />
                    <span className="ml-3 h-5 flex-1 rounded-md bg-white" />
                  </div>
                  <div
                    className="h-[240px]"
                    style={{ background: "#f4f2ec" }}
                  />
                </div>
              </div>

              <div className="shrink-0 px-6 pb-6 pt-4">
                <span
                  className="text-[12px] font-medium"
                  style={{ color: "rgba(255,255,255,0.52)" }}
                >
                  {t("reports.authGate.inThisReport")}
                </span>
                <ul className="mt-1.5 flex flex-col">
                  {getBackdropFindings(t).map((title, i) => (
                    <li
                      key={i}
                      className="flex items-center gap-3 border-t py-2.5"
                      style={{ borderColor: "rgba(255,255,255,0.1)" }}
                    >
                      <span
                        className="w-4 shrink-0 text-[11px] tabular-nums"
                        style={{ color: "rgba(208,236,26,0.8)" }}
                      >
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-[14px] leading-[1.35]"
                        style={{ color: "rgba(255,255,255,0.9)" }}
                      >
                        {title}
                      </span>
                    </li>
                  ))}
                </ul>
                <span
                  className="mt-4 flex h-11 w-full items-center justify-center rounded-full text-sm font-medium"
                  style={{ background: DECK.lime, color: DECK.forest }}
                >
                  {t("reports.authGate.unlockReport")}
                </span>
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
