import { useState } from "react";
import type { CtaProps } from "@/reports/deck-types";
import Icon from "../icon";
import { trackConnectCta } from "../onboarding";
import { useReportCtaHref } from "../use-report-cta-href";
import { DECK } from "./tokens";

// ── closing pitch (Figma: Product 2, node 9317-17836) ────────────────────────
// Centered hero over a dark-green card: a count pill, the payoff headline, sub,
// and CTA; a marquee of every audited dimension (each its own icon); and a
// report card peeking from the bottom with the scored areas.

const HEADLINE_A = "Acesse a análise completa e";
const HEADLINE_B = "opere seu site no piloto automático.";
const SUB_A = "389 verificações em 15 dimensões, cada problema com uma";
const SUB_B = "próxima ação clara. A Deco corrige por você.";
const CTA_LABEL = "Ver diagnóstico completo";

const CARD = DECK.forest;
const LIME = DECK.lime;

// The audited dimensions — each with its own icon and accent (the marquee).
type Pill = { label: string; icon: string; color: string };
const PILLS: Pill[] = [
  { label: "SEO", icon: "search", color: "#ffc116" },
  { label: "Busca por IA", icon: "smart_toy", color: "#14b8a6" },
  { label: "Performance", icon: "bolt", color: "#a595ff" },
  { label: "Conversão", icon: "shopping_cart", color: "#ffc116" },
  { label: "Rastreamento", icon: "monitoring", color: "#6e9fdb" },
  { label: "Acessibilidade", icon: "accessibility_new", color: "#b7a8ff" },
  { label: "Segurança", icon: "shield", color: "#f0846b" },
  { label: "Conteúdo", icon: "article", color: "#ffc116" },
  { label: "Analytics & Funil", icon: "bar_chart", color: "#a3c73a" },
];

// The scored areas shown inside the report card (from the attached spec).
type ReportArea = { label: string; score: number; color: string };
const REPORT_AREAS: ReportArea[] = [
  { label: "Conversão", score: 42, color: "#6e9fdb" },
  { label: "Performance", score: 35, color: "#a595ff" },
  { label: "SEO", score: 54, color: "#f0b613" },
  { label: "Busca por IA (GEO)", score: 67, color: "#14b8a6" },
  { label: "Acessibilidade", score: 48, color: "#8aa9ff" },
  { label: "Segurança", score: 31, color: "#f0846b" },
  { label: "Analytics & Funil", score: 75, color: "#8caa25" },
];

const SEGMENTS = 14;

// Fixes queued from the findings — the falling backlog on the left.
type FixTask = { title: string; level: string; color: string };
const FIX_TASKS: FixTask[] = [
  {
    title: "Corrigir LCP acima de 4s na home",
    level: "Alta",
    color: "#d43d3d",
  },
  {
    title: "Adicionar canonical em 12 páginas",
    level: "Alta",
    color: "#d43d3d",
  },
  { title: "Liberar GPTBot no robots.txt", level: "Média", color: "#f0b613" },
  { title: "Corrigir GA4 duplicando eventos", level: "Alta", color: "#d43d3d" },
  { title: "Adicionar alt em 18 imagens", level: "Média", color: "#f0b613" },
  { title: "Reduzir checkout para 3 campos", level: "Alta", color: "#d43d3d" },
  { title: "Ativar HSTS e CSP", level: "Média", color: "#f0b613" },
];

// Delivery cadence heatmap (7 rows × 16 weeks), deterministic so it's stable.
const HEAT_ROWS = 7;
const HEAT_COLS = 16;
const HEAT_PALETTE = ["#8caa2510", "#cfe8b8", "#9fd07f", "#5fa843", "#0c5122"];
function heatLevel(row: number, col: number): number {
  return (row * 3 + col * 5 + ((row * col) % 4)) % 5;
}

const CADENCE_METRICS = [
  { label: "Tempo médio até corrigir", value: "3 dias" },
  { label: "Correções esta semana", value: "7" },
  { label: "Em revisão", value: "2" },
];

// ── marquee pill ──────────────────────────────────────────────────────────────

function DimensionPill({ label, icon, color }: Pill) {
  return (
    <span
      className="flex shrink-0 items-center gap-2.5 rounded-full py-2 pl-3 pr-5"
      style={{ border: "1px solid rgba(255,255,255,0.25)" }}
    >
      <span style={{ color }}>
        <Icon name={icon} size="xl" />
      </span>
      <span
        className="whitespace-nowrap text-[15px]"
        style={{ color: "#ffffff" }}
      >
        {label}
      </span>
    </span>
  );
}

// ── report card (peeks from the bottom) ───────────────────────────────────────

function SegmentBar({ score, color }: { score: number; color: string }) {
  const filled = Math.round((score / 100) * SEGMENTS);
  return (
    <span className="flex flex-1 items-center gap-[3px]">
      {Array.from({ length: SEGMENTS }, (_, i) => (
        <span
          key={i}
          className="h-2.5 flex-1 rounded-[3px]"
          style={{ background: i < filled ? color : "rgba(40,37,36,0.08)" }}
        />
      ))}
    </span>
  );
}

function ReportCard({
  domain,
  faviconUrl,
  initial,
}: {
  domain: string;
  faviconUrl: string;
  initial: string;
}) {
  const [faviconFailed, setFaviconFailed] = useState(false);
  return (
    <div
      className="w-[min(92vw,600px)] rounded-t-2xl bg-white p-6 sm:p-7"
      style={{ boxShadow: "0 -20px 60px rgba(3,32,14,0.35)" }}
    >
      {/* header */}
      <div className="flex items-center gap-2.5">
        <span
          className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md"
          style={{ border: `1px solid ${DECK.border}` }}
        >
          {faviconFailed ? (
            <span
              className="text-[11px] font-semibold"
              style={{ color: DECK.forest }}
            >
              {initial}
            </span>
          ) : (
            <img
              src={faviconUrl}
              alt=""
              className="size-4 object-contain"
              onError={() => setFaviconFailed(true)}
            />
          )}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-[15px] font-medium"
          style={{ color: DECK.ink }}
        >
          {domain}
        </span>
        <span
          className="text-[12px] font-semibold uppercase tracking-wide"
          style={{ color: DECK.soft }}
        >
          Diagnóstico
        </span>
      </div>

      {/* scored areas */}
      <ul className="mt-5 flex flex-col gap-4">
        {REPORT_AREAS.map((area) => (
          <li key={area.label} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between">
              <span
                className="text-[11px] font-semibold uppercase tracking-wide"
                style={{ color: DECK.ink }}
              >
                {area.label}
              </span>
              <span
                className="text-[15px] font-semibold tabular-nums"
                style={{ color: DECK.ink }}
              >
                {area.score}
                <span
                  className="text-[11px] font-normal"
                  style={{ color: DECK.faint }}
                >
                  /100
                </span>
              </span>
            </div>
            <SegmentBar score={area.score} color={area.color} />
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── falling task backlog (left, decorative) ──────────────────────────────────

function TaskCard({ title, level, color }: FixTask) {
  return (
    <div
      className="rounded-xl bg-white p-3"
      style={{
        border: `1px solid ${DECK.border}`,
        boxShadow: "0 6px 20px rgba(3,32,14,0.12)",
      }}
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 size-3.5 shrink-0 rounded-full"
          style={{ border: `1.5px solid ${DECK.faint}` }}
        />
        <span
          className="text-[12.5px] font-medium leading-snug"
          style={{ color: DECK.ink }}
        >
          {title}
        </span>
      </div>
      <span
        className="mt-2 ml-5 inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px]"
        style={{ background: "rgba(40,37,36,0.04)", color: DECK.muted }}
      >
        <span className="size-1.5 rounded-full" style={{ background: color }} />
        {level}
      </span>
    </div>
  );
}

function TaskStream() {
  return (
    <div
      className="h-[400px] w-[248px] overflow-hidden"
      style={{
        maskImage:
          "linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent)",
        WebkitMaskImage:
          "linear-gradient(to bottom, transparent, #000 18%, #000 82%, transparent)",
      }}
    >
      <div className="report-task-track gap-3">
        {[...FIX_TASKS, ...FIX_TASKS].map((t, i) => (
          <TaskCard key={`${t.title}-${i}`} {...t} />
        ))}
      </div>
    </div>
  );
}

// ── delivery cadence card (right, decorative) ─────────────────────────────────

function CadenceCard() {
  return (
    <div
      className="w-[320px] rounded-2xl bg-white p-5"
      style={{ boxShadow: "0 20px 50px rgba(3,32,14,0.22)" }}
    >
      <span
        className="text-[11px] font-semibold uppercase tracking-wide"
        style={{ color: DECK.soft }}
      >
        Ritmo de entrega
      </span>
      <div
        className="mt-4 grid gap-[3px]"
        style={{ gridTemplateColumns: `repeat(${HEAT_COLS}, 1fr)` }}
      >
        {Array.from({ length: HEAT_ROWS * HEAT_COLS }, (_, i) => {
          const row = Math.floor(i / HEAT_COLS);
          const col = i % HEAT_COLS;
          return (
            <span
              key={i}
              className="aspect-square rounded-[3px]"
              style={{ background: HEAT_PALETTE[heatLevel(row, col)] }}
            />
          );
        })}
      </div>
      <ul className="mt-4 flex flex-col">
        {CADENCE_METRICS.map((m) => (
          <li
            key={m.label}
            className="flex items-center justify-between py-2.5 text-[13px]"
            style={{ borderTop: `1px solid ${DECK.border}` }}
          >
            <span style={{ color: DECK.muted }}>{m.label}</span>
            <span className="font-semibold" style={{ color: DECK.ink }}>
              {m.value}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── slide ─────────────────────────────────────────────────────────────────────

/**
 * Closing CTA slide (always last). Centered hero on a dark-green card, a marquee
 * of the audited dimensions, and a report card peeking from the bottom with the
 * scored areas. The primary action lives in the slide on desktop; on mobile the
 * deck footer carries it too.
 */
export default function CtaTemplate({
  domain,
  faviconUrl,
  initial,
  checksProbed,
  checksTotal,
  active = false,
}: CtaProps) {
  const show = active ? "true" : "false";
  const ctaHref = useReportCtaHref(domain);
  const hasCoverage =
    typeof checksProbed === "number" && typeof checksTotal === "number";
  return (
    <div className="h-full w-full sm:px-6 lg:px-10 sm:pb-2">
      <div
        className="relative flex h-full w-full flex-col items-center gap-8 overflow-hidden rounded-none px-6 pb-0 pt-8 sm:rounded-3xl sm:px-8 sm:pt-10 lg:gap-10 lg:pt-14 [@media(max-height:780px)]:lg:gap-6 [@media(max-height:780px)]:lg:pt-10"
        style={{ background: CARD }}
      >
        {/* soft glow behind the composition */}
        <div
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-[52%] size-[900px] -translate-x-1/2 rounded-full"
          style={{
            background:
              "radial-gradient(circle, rgba(208,236,26,0.08), transparent 62%)",
          }}
        />

        {/* hero */}
        <div className="relative z-10 flex max-w-[820px] flex-col items-center gap-5 text-center">
          {hasCoverage ? (
            <span
              className="reveal rounded-full px-4 py-1.5 text-[15px]"
              data-show={show}
              style={{ border: "1px solid rgba(255,255,255,0.25)" }}
            >
              <span style={{ color: "rgba(255,255,255,0.5)" }}>
                {checksProbed}/
              </span>
              <span style={{ color: "#ffffff" }}>{checksTotal}</span>
            </span>
          ) : null}

          <h2
            className="reveal text-balance font-normal leading-[1.15] tracking-[-0.015em] text-[clamp(1.5rem,6vw,2.75rem)]"
            data-show={show}
            style={{
              color: "#ffffff",
              transitionDelay: active ? "60ms" : "0ms",
            }}
          >
            {HEADLINE_A}
            <br className="hidden sm:block" /> {HEADLINE_B}
          </h2>

          <p
            className="reveal max-w-[520px] text-[15px] leading-relaxed sm:text-base"
            data-show={show}
            style={{
              color: "rgba(255,255,255,0.75)",
              transitionDelay: active ? "130ms" : "0ms",
            }}
          >
            {SUB_A}
            <br className="hidden sm:block" /> {SUB_B}
          </p>

          <a
            href={ctaHref}
            onClick={(e) =>
              trackConnectCta(e, {
                domain,
                placement: "cta_slide",
                slideKey: "cta",
              })
            }
            className="reveal mt-1 inline-flex h-12 items-center gap-2 whitespace-nowrap rounded-full px-8 text-base font-medium transition-transform duration-300 ease-out hover:scale-105"
            data-show={show}
            style={{
              background: LIME,
              color: DECK.forest,
              transitionDelay: active ? "220ms" : "0ms",
            }}
          >
            <span>{CTA_LABEL}</span>
            <Icon name="arrow_forward" size="medium" />
          </a>
        </div>

        {/* dimension marquee — bleeds past the card edges, fades at the sides */}
        <div
          className="reveal relative z-10 w-[calc(100%+4rem)] shrink-0 overflow-hidden sm:w-[calc(100%+8rem)]"
          data-show={show}
          style={{
            transitionDelay: active ? "300ms" : "0ms",
            maskImage:
              "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)",
            WebkitMaskImage:
              "linear-gradient(90deg, transparent, #000 8%, #000 92%, transparent)",
          }}
        >
          <div className="report-marquee-track gap-2">
            {[...PILLS, ...PILLS].map((p, i) => (
              <DimensionPill key={`${p.label}-${i}`} {...p} />
            ))}
          </div>
        </div>

        {/* bottom stage: report card center, backlog left, cadence right.
            All top-aligned so tops stay visible and bottoms peek off-slide;
            side cards tuck behind the report card via negative margins. */}
        <div className="relative z-10 flex w-full flex-1 items-start justify-center overflow-hidden">
          {/* left: falling backlog of fixes (behind, decorative) */}
          <div
            className="reveal pointer-events-none relative z-0 -mr-24 mt-3 hidden shrink-0 -rotate-[5deg] xl:block"
            data-show={show}
            style={{ transitionDelay: active ? "460ms" : "0ms" }}
          >
            <TaskStream />
          </div>

          {/* center: the diagnostic report card */}
          <div
            className="reveal relative z-20 shrink-0"
            data-show={show}
            style={{ transitionDelay: active ? "380ms" : "0ms" }}
          >
            <ReportCard
              domain={domain}
              faviconUrl={faviconUrl}
              initial={initial}
            />
          </div>

          {/* right: delivery cadence card (behind, tilted) */}
          <div
            className="reveal pointer-events-none relative z-0 -ml-24 mt-3 hidden shrink-0 rotate-[6deg] xl:block"
            data-show={show}
            style={{ transitionDelay: active ? "440ms" : "0ms" }}
          >
            <CadenceCard />
          </div>
        </div>
      </div>
    </div>
  );
}
