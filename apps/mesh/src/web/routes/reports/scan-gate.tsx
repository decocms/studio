import posthog from "posthog-js";
import { useState } from "react";
import type { TemplateDeck } from "@/reports/deck-types";
import { faviconForDomain } from "@/shared/report-seo";
import type { ReportState } from "@/reports/to-deck";
import { isPostHogInitialized } from "@/web/lib/posthog-client";
import { useT } from "@/web/i18n/use-t.ts";
import {
  orchestrateScan,
  readPending,
  reportDrops,
  type ScanPhase,
} from "./orchestrate-scan";
import { ReportAuthGate, ReportBackdrop } from "./auth-gate";
import { ReportSocialProof } from "./report-social-proof";
import SignalDeck from "./signal-deck";
import { DECK } from "./templates/tokens";

const LIME = "#D0EC1A";
const FOREST = "#07401A";

const distinctId = () =>
  isPostHogInitialized() ? posthog.get_distinct_id() : undefined;

export default function ScanGate({
  domain,
  initial,
  sessionEmail,
}: {
  domain: string;
  initial?: ReportState;
  sessionEmail: string;
}) {
  const [deck, setDeck] = useState<TemplateDeck | null>(
    initial?.status === "ready" ? initial.deck : null,
  );
  const [phase, setPhase] = useState<ScanPhase>(() =>
    initial?.status !== "ready" && readPending(domain) ? "pending" : "scanning",
  );

  // Kick the scan lifecycle on mount (callback ref, aborted on unmount). The
  // ref re-attaches when `domain` changes — the abort cancels the old run.
  const scanRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    if (initial) reportDrops(domain, initial.drops);
    if (initial?.status === "ready") return;
    const controller = new AbortController();
    orchestrateScan(domain, distinctId(), controller.signal, {
      onPhase: setPhase,
      onDeck: setDeck,
    });
    return () => controller.abort();
  };

  if (deck) return <SignalDeck deck={deck} />;
  if (phase === "unauthorized") {
    return <ReportAuthGate domain={domain} />;
  }

  return (
    <div ref={scanRef}>
      <ScanScreen domain={domain} phase={phase} email={sessionEmail} />
    </div>
  );
}

// ── delivery stages ───────────────────────────────────────────────────────────

const STAGES = [
  {
    id: "initiated",
    labelKey: "reports.scanGate.stageInitiated",
    detail: null,
  },
  {
    id: "collecting",
    labelKey: "reports.scanGate.stageCollecting",
    detail: null,
  },
  { id: "building", labelKey: "reports.scanGate.stageBuilding", detail: null },
  { id: "ready", labelKey: "reports.scanGate.stageReady", detail: null },
] as const;

type StageState = "done" | "active" | "pending";

function stagesFor(phase: ScanPhase): StageState[] {
  if (phase === "scanning") return ["done", "active", "pending", "pending"];
  if (phase === "pending") return ["done", "done", "active", "pending"];
  return ["done", "done", "done", "pending"];
}

// ── page shell ────────────────────────────────────────────────────────────────

function ScanScreen({
  domain,
  phase,
  email,
}: {
  domain: string;
  phase: ScanPhase;
  email: string;
}) {
  const t = useT();
  const isActive = phase === "scanning" || phase === "pending";
  const stages = stagesFor(phase);

  const errorMessage =
    phase === "blocked"
      ? t("reports.scanGate.errorBlocked")
      : phase === "empty"
        ? t("reports.scanGate.errorEmpty")
        : phase === "error"
          ? t("reports.scanGate.errorFailed")
          : null;

  return (
    <div
      className="fixed inset-0 overflow-y-auto"
      style={{
        color: DECK.ink,
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
    >
      <ReportBackdrop domain={domain} />
      <div className="pointer-events-none absolute inset-0 bg-white/35" />

      {/* Lime progress strip */}
      <div
        className="fixed inset-x-0 top-0 z-10 h-[2px] overflow-hidden"
        style={{ background: "rgba(255,255,255,0.15)" }}
      >
        {isActive && (
          <div
            className="animate-indeterminate h-full w-2/5"
            style={{ background: LIME }}
          />
        )}
      </div>

      <div className="relative z-10 flex min-h-full flex-col items-center justify-center px-3 py-4 sm:px-5 sm:py-16">
        {isActive && (
          <div
            className="w-full max-w-[460px] rounded-2xl sm:rounded-3xl px-5 pt-5 pb-6 sm:px-8 sm:pt-8 sm:pb-9"
            style={{
              background: "#fff",
              boxShadow:
                "0 24px 64px rgba(0,0,0,0.22), 0 4px 16px rgba(0,0,0,0.12)",
            }}
          >
            {/* Domain pill */}
            <div
              className="mb-4 sm:mb-6 inline-flex items-center gap-2 rounded-full border px-3 py-1.5"
              style={{ borderColor: DECK.border, background: "#FAFAF9" }}
            >
              <img
                src={faviconForDomain(domain)}
                alt=""
                className="h-4 w-4 rounded object-contain"
              />
              <span className="text-[13px]" style={{ color: DECK.muted }}>
                <span style={{ opacity: 0.5 }}>https://</span>
                {domain}
              </span>
            </div>

            {/* Headline */}
            <h1
              className="text-[24px] sm:text-[32px] font-normal leading-[1.18] tracking-[-0.025em]"
              style={{ color: DECK.ink }}
            >
              {t("reports.scanGate.headlineStart")}
              <br />
              <span style={{ color: DECK.soft }}>
                {t("reports.scanGate.headlineEnd")}
              </span>
            </h1>
            <p
              className="mt-2 sm:mt-3 text-[13px] sm:text-[14px] leading-[1.6]"
              style={{ color: DECK.muted }}
            >
              {t("reports.scanGate.subtitle")}
            </p>

            {/* Authenticated delivery address */}
            <div
              className="mt-4 sm:mt-5 rounded-xl sm:rounded-2xl px-4 sm:px-5 py-4 sm:py-5"
              style={{ background: "#F2F1EF" }}
            >
              <p
                className="mb-2.5 sm:mb-3 text-[15px] sm:text-[16px]"
                style={{ color: DECK.ink }}
              >
                {t("reports.scanGate.notificationLabel")}
              </p>
              <NotificationEmail email={email} />
            </div>

            {/* Tracker */}
            <div
              className="mt-5 sm:mt-7 rounded-xl sm:rounded-2xl overflow-hidden"
              style={{ border: `1px solid ${DECK.border}` }}
            >
              {STAGES.map((s, i) => {
                const state = stages[i] ?? "pending";
                const isLast = i === STAGES.length - 1;
                return (
                  <div
                    key={s.id}
                    className="flex items-start gap-3 sm:gap-4 px-4 sm:px-5 py-3 sm:py-4"
                    style={{
                      borderTop: i > 0 ? `1px solid ${DECK.border}` : undefined,
                      background:
                        state === "active" ? DECK.limeTint : undefined,
                    }}
                  >
                    {/* Icon + rail */}
                    <div className="flex flex-col items-center self-stretch pt-0.5">
                      <StepDot state={state} />
                      {!isLast && (
                        <div
                          className="w-px flex-1 mt-2"
                          style={{
                            background:
                              state === "done" ? DECK.soft : DECK.border,
                            opacity: state === "done" ? 0.5 : 1,
                          }}
                        />
                      )}
                    </div>
                    {/* Text */}
                    <div className="min-w-0 flex-1 py-0.5">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-[13px] sm:text-[14px] leading-5"
                          style={{
                            color: state === "pending" ? DECK.faint : DECK.ink,
                            fontWeight: state === "active" ? 500 : 400,
                          }}
                        >
                          {t(s.labelKey)}
                        </span>
                        {state === "active" && (
                          <span
                            className="text-[11px] px-1.5 py-0.5 rounded-md font-medium"
                            style={{
                              background: DECK.limeTint,
                              color: FOREST,
                              border: `1px solid rgba(7,64,26,0.15)`,
                            }}
                          >
                            {t("reports.scanGate.stageNow")}
                          </span>
                        )}
                      </div>
                      {s.detail && state !== "pending" && (
                        <p
                          className="mt-0.5 text-[12px] leading-4"
                          style={{ color: DECK.faint }}
                        >
                          {s.detail}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <ReportSocialProof />
          </div>
        )}

        {errorMessage && (
          <div
            className="w-full max-w-[460px] rounded-3xl px-8 py-10"
            style={{
              background: "#fff",
              boxShadow:
                "0 24px 64px rgba(0,0,0,0.22), 0 4px 16px rgba(0,0,0,0.12)",
            }}
          >
            <div
              className="mb-5 flex h-10 w-10 items-center justify-center rounded-full"
              style={{ background: "rgba(212,61,61,0.08)" }}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 22 22"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M11 7v5M11 15h.01"
                  stroke="#d43d3d"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle
                  cx="11"
                  cy="11"
                  r="9"
                  stroke="#d43d3d"
                  strokeWidth="1.5"
                />
              </svg>
            </div>
            <p
              className="text-[20px] font-normal leading-snug tracking-[-0.02em]"
              style={{ color: DECK.ink }}
            >
              {errorMessage}
            </p>
            <a
              href="https://decocms.com/diagnostico"
              className="mt-5 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-[14px] font-medium transition-transform active:scale-[0.98]"
              style={{ background: DECK.primary, color: DECK.primaryFg }}
            >
              {t("reports.scanGate.tryAnother")}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

// ── step dot ──────────────────────────────────────────────────────────────────

function StepDot({ state }: { state: StageState }) {
  if (state === "done") {
    return (
      <div
        className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full"
        style={{ background: DECK.soft }}
      >
        <svg
          width="9"
          height="9"
          viewBox="0 0 9 9"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M1.5 4.5l2 2L7.5 2.5"
            stroke="#fff"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  }
  if (state === "active") {
    return (
      <div className="relative flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <div
          className="absolute h-full w-full rounded-full animate-ping opacity-30"
          style={{ background: DECK.soft }}
        />
        <div
          className="h-3 w-3 rounded-full"
          style={{ background: DECK.soft }}
        />
      </div>
    );
  }
  return (
    <div
      className="h-[18px] w-[18px] shrink-0 rounded-full"
      style={{ border: `1.5px solid ${DECK.border}` }}
    />
  );
}

// ── authenticated delivery address ──────────────────────────────────────────

function NotificationEmail({ email }: { email: string }) {
  const t = useT();
  return (
    <div
      className="flex min-w-0 items-center gap-3 rounded-xl px-4 py-3"
      style={{ background: DECK.limeTint }}
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{ background: DECK.soft }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M2 6l2.5 2.5L10 3.5"
            stroke="#fff"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <div className="min-w-0">
        <p
          className="truncate text-[13px] font-medium"
          style={{ color: FOREST }}
        >
          {email}
        </p>
        <p className="text-[12px]" style={{ color: DECK.soft }}>
          {t("reports.scanGate.notificationHelp")}
        </p>
      </div>
    </div>
  );
}
