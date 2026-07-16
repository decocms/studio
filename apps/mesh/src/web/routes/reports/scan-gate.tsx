import posthog from "posthog-js";
import { useState } from "react";
import type { TemplateDeck } from "@/reports/deck-types";
import { faviconForDomain } from "@/shared/report-seo";
import type { ReportState } from "@/reports/to-deck";
import { isPostHogInitialized } from "@/web/lib/posthog-client";
import { runReportScan } from "./api";
import {
  orchestrateScan,
  readPending,
  reportDrops,
  type ScanPhase,
  writePending,
} from "./orchestrate-scan";
import SignalDeck from "./signal-deck";
import { captureReport } from "./track";
import { DECK } from "./templates/tokens";

const LIME = "#D0EC1A";
const FOREST = "#07401A";

const distinctId = () =>
  isPostHogInitialized() ? posthog.get_distinct_id() : undefined;

// Full logo set — intrinsic pixel dimensions prevent SVG blowup
const CAROUSEL_LOGOS = [
  { src: "/logos/summit/fila.svg", alt: "Fila", w: 100, h: 34 },
  { src: "/logos/summit/osklen.svg", alt: "Osklen", w: 152, h: 21 },
  { src: "/logos/summit/farm-rio.svg", alt: "Farm Rio", w: 159, h: 23 },
  { src: "/logos/summit/electrolux.svg", alt: "Electrolux", w: 154, h: 35 },
  { src: "/logos/summit/monte-carlo.svg", alt: "Monte Carlo", w: 116, h: 61 },
  { src: "/logos/summit/leroy-merlin.svg", alt: "Leroy Merlin", w: 109, h: 62 },
  { src: "/logos/summit/technos.svg", alt: "Technos", w: 141, h: 29 },
  { src: "/logos/summit/bagaggio.svg", alt: "Bagaggio", w: 149, h: 22 },
  { src: "/logos/summit/le-biscuit.svg", alt: "Le Biscuit", w: 141, h: 24 },
  { src: "/logos/summit/miess.svg", alt: "Miess", w: 113, h: 43 },
  { src: "/logos/summit/casa-e-video.svg", alt: "Casa & Video", w: 145, h: 18 },
  { src: "/logos/summit/hering-fill.svg", alt: "Hering", w: 140, h: 30 },
] as const;

const CAROUSEL_COLS = 4;
const CYCLE_MS = 2400;

// Split logos into N columns (round-robin, deterministic)
function splitLogos(n: number) {
  const cols: (typeof CAROUSEL_LOGOS)[number][][] = Array.from(
    { length: n },
    () => [],
  );
  CAROUSEL_LOGOS.forEach((logo, i) => cols[i % n]?.push(logo));
  return cols;
}

export default function ScanGate({
  domain,
  initial,
}: {
  domain: string;
  initial?: ReportState;
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

  return (
    <div ref={scanRef}>
      <ScanScreen domain={domain} phase={phase} />
    </div>
  );
}

// ── delivery stages ───────────────────────────────────────────────────────────

const STAGES = [
  { id: "initiated", label: "Análise iniciada", detail: null },
  { id: "collecting", label: "Coletando dados públicos", detail: null },
  { id: "building", label: "Montando seu relatório", detail: null },
  { id: "ready", label: "Relatório pronto", detail: null },
] as const;

type StageState = "done" | "active" | "pending";

function stagesFor(phase: ScanPhase): StageState[] {
  if (phase === "scanning") return ["done", "active", "pending", "pending"];
  if (phase === "pending") return ["done", "done", "active", "pending"];
  return ["done", "done", "done", "pending"];
}

// ── page shell ────────────────────────────────────────────────────────────────

function ScanScreen({ domain, phase }: { domain: string; phase: ScanPhase }) {
  const isActive = phase === "scanning" || phase === "pending";
  const stages = stagesFor(phase);

  const errorMessage =
    phase === "blocked"
      ? "Este relatório não está disponível publicamente."
      : phase === "empty"
        ? "Escaneamos sua loja, mas o relatório ainda está sendo montado. Verifique em breve."
        : phase === "error"
          ? "Algo deu errado ao acessar o relatório. Tente novamente."
          : null;

  return (
    <div
      className="fixed inset-0 overflow-y-auto"
      style={{
        background: FOREST,
        color: DECK.ink,
        fontFamily: "Switzer, 'Inter var', Helvetica, Arial, sans-serif",
        WebkitFontSmoothing: "antialiased",
      }}
    >
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

      <div className="flex min-h-full flex-col items-center justify-center px-3 py-4 sm:px-5 sm:py-16">
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
              Seu relatório está
              <br />
              <span style={{ color: DECK.soft }}>sendo preparado.</span>
            </h1>
            <p
              className="mt-2 sm:mt-3 text-[13px] sm:text-[14px] leading-[1.6]"
              style={{ color: DECK.muted }}
            >
              Deixe seu email abaixo e avisamos quando estiver pronto.
            </p>

            {/* Email capture */}
            <div
              className="mt-4 sm:mt-5 rounded-xl sm:rounded-2xl px-4 sm:px-5 py-4 sm:py-5"
              style={{ background: "#F2F1EF" }}
            >
              <p
                className="mb-2.5 sm:mb-3 text-[15px] sm:text-[16px]"
                style={{ color: DECK.ink }}
              >
                Receba uma notificação quando ficar pronto:
              </p>
              <EmailCapture domain={domain} />
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
                          {s.label}
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
                            agora
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

            {/* Social proof */}
            <div
              className="mt-8 pt-6"
              style={{ borderTop: `1px solid ${DECK.border}` }}
            >
              <p
                className="mb-4 text-[11px] uppercase tracking-[0.04em] text-center"
                style={{ color: DECK.faint }}
              >
                Já receberam
              </p>
              <LogoCarousel />
            </div>
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
              Tentar outra loja
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

// ── email capture ─────────────────────────────────────────────────────────────

function EmailCapture({ domain }: { domain: string }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(() => readPending(domain)?.emailed ?? false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || sent) return;
    setSent(true);
    writePending(domain, { emailed: true });
    captureReport("report_pending_email", { domain, surface: "deck_v2" });
    if (isPostHogInitialized()) {
      posthog.setPersonProperties({
        email: email.trim(),
        last_scanned_domain: domain,
      });
    }
    runReportScan({
      domain,
      email: email.trim(),
      distinctId: distinctId(),
    }).catch(() => {});
  }

  if (sent) {
    return (
      <div
        className="flex items-center gap-3 rounded-xl px-4 py-3"
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
        <div>
          <p className="text-[13px] font-medium" style={{ color: FOREST }}>
            Email registrado
          </p>
          <p className="text-[12px]" style={{ color: DECK.soft }}>
            Avisamos assim que ficar pronto.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex items-center gap-3">
      <input
        id="notify-email"
        type="email"
        required
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="seu@email.com"
        className="scan-gate-input min-w-0 flex-1 h-12 px-6 rounded-full text-[15px] outline-none transition-colors"
        style={{
          background: "#fff",
          border: `1px solid ${DECK.inputBorder}`,
          color: DECK.ink,
        }}
      />
      <button
        type="submit"
        className="shrink-0 cursor-pointer h-12 px-6 rounded-full text-[15px] font-medium transition-transform active:scale-[0.97]"
        style={{ background: DECK.primary, color: DECK.primaryFg }}
      >
        Avisar
      </button>
    </form>
  );
}

// ── logo carousel ─────────────────────────────────────────────────────────────

type LogoEntry = (typeof CAROUSEL_LOGOS)[number];

function LogoCol({
  logos,
  delayMs,
  last,
  bottomRow,
}: {
  logos: LogoEntry[];
  delayMs: number;
  last?: boolean;
  bottomRow?: boolean;
}) {
  const [idx, setIdx] = useState(0);

  // Staggered cycle timer, alive while the column is mounted.
  const cycleRef = (el: HTMLDivElement | null) => {
    if (!el) return;
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      interval = setInterval(
        () => setIdx((i) => (i + 1) % logos.length),
        CYCLE_MS,
      );
    }, delayMs);
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  };

  const logo = logos[idx % logos.length] ?? logos[0];
  if (!logo) return null;

  // These SVGs have preserveAspectRatio="none" width="100%" height="100%",
  // so they stretch to fill whatever pixel box you give them. The only fix
  // is computing the exact proportional pixel dimensions from the viewBox.
  const MAX_W = 78;
  const MAX_H = 22;
  const scale = Math.min(MAX_W / logo.w, MAX_H / logo.h);
  const renderW = Math.round(logo.w * scale);
  const renderH = Math.round(logo.h * scale);

  return (
    <div
      ref={cycleRef}
      className="flex flex-1 items-center justify-center overflow-hidden py-3"
      style={{
        borderRight: last ? undefined : `1px solid ${DECK.border}`,
        borderTop: bottomRow ? `1px solid ${DECK.border}` : undefined,
      }}
    >
      <img
        key={idx}
        src={logo.src}
        alt={logo.alt}
        width={renderW}
        height={renderH}
        className="logo-carousel-enter block"
      />
    </div>
  );
}

function LogoCarousel() {
  const cols = splitLogos(CAROUSEL_COLS);
  return (
    <>
      {/* 2×2 on mobile */}
      <div
        className="grid grid-cols-2 overflow-hidden rounded-xl sm:hidden"
        style={{ border: `1px solid ${DECK.border}` }}
      >
        {cols.map((logos, i) => (
          <LogoCol
            key={i}
            logos={logos}
            delayMs={i * 380}
            last={false}
            bottomRow={i >= 2}
          />
        ))}
      </div>
      {/* 4 columns on sm+ */}
      <div
        className="hidden sm:flex overflow-hidden rounded-xl"
        style={{ border: `1px solid ${DECK.border}` }}
      >
        {cols.map((logos, i) => (
          <LogoCol
            key={i}
            logos={logos}
            delayMs={i * 380}
            last={i === cols.length - 1}
          />
        ))}
      </div>
    </>
  );
}
