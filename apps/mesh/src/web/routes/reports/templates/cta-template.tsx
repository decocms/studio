import { cn } from "@deco/ui/lib/utils.ts";
import type React from "react";
import { useState } from "react";
import type { CtaProps } from "@/reports/deck-types";
import Icon from "../icon";
import { trackConnectCta } from "../onboarding";
import { useReportCtaHref } from "../use-report-cta-href";
import { FLOR_PATH } from "./motifs";
import { DECK } from "./tokens";

// Closing pitch copy — sells the full connected report product.
const HEADLINE_LEAD = "Sua loja tem receita parada.";
const HEADLINE_ACCENT = "Vamos encontrá-la.";
const CTA_LABEL = "Conectar minha loja";

// Brand greens from the Figma card (brand-green-dark / brand-green-light).
const CARD = DECK.forest;
const LIME = DECK.lime;
const LIME_INK = DECK.forest;

// God-rays for the unlock burst: lime spokes, masked to a ring band so they
// radiate around the emblem (never over it).
const RAYS_BG =
  "repeating-conic-gradient(from 0deg, rgba(208,236,26,0.55) 0deg 3deg, transparent 3deg 11deg)";
const RAYS_MASK =
  "radial-gradient(circle, transparent 26%, #000 44%, #000 60%, transparent 80%)";

type Bullet = { label: string; desc: string; color: string; icon: string };

const BULLETS: Bullet[] = [
  {
    label: "Veja onde seus concorrentes estão na frente",
    desc: "Comparação direta com as marcas que disputam o mesmo cliente",
    color: "#a595ff",
    icon: "leaderboard",
  },
  {
    label: "O que corrigir primeiro",
    desc: "Priorizado por impacto em receita, com esforço estimado",
    color: "#ffc116",
    icon: "checklist",
  },
  {
    label: "Monitoramento contínuo",
    desc: "Alertas quando concorrentes se mexem, correções automáticas",
    color: DECK.lime,
    icon: "notifications_active",
  },
];

// The data sources the report connects to (Figma: VTEX, Search Console, GA4).
// SimpleIcons serves each brand's logo in its own colour so the three read as
// distinct (not three generic Google "G"s).
const SOURCES = [
  { label: "VTEX", src: "https://cdn.simpleicons.org/vtex" },
  {
    label: "Google Search Console",
    src: "https://cdn.simpleicons.org/googlesearchconsole",
  },
  {
    label: "Google Analytics 4",
    src: "https://cdn.simpleicons.org/googleanalytics",
  },
];

// Mini report-card pills that fly out of the box — representing real outputs
// from the full report: the action plan, the SEO gap, and autofix agents.
const REPORT_CARDS: { label: string; color: string; rotate: number }[] = [
  { label: "47 passos", color: "#ffc116", rotate: -8 },
  { label: "SEO −38pts", color: "#a595ff", rotate: 3 },
  { label: "Autofix 3×", color: "#67e8f9", rotate: 9 },
];

// ── 3-D gift box ─────────────────────────────────────────────────────────────

const FACE: React.CSSProperties = { position: "absolute" };

/** Proper CSS preserve-3d box. W=D=130 (cube), H=96 → half-W/D=65. */
function BoxVisual() {
  // Side faces: W×H = 130×96, centred vertically in the 130px cube (top:17)
  const side: React.CSSProperties = {
    ...FACE,
    width: 130,
    height: 96,
    top: 17,
    left: 0,
  };
  // Top/bottom faces: W×D = 130×130
  const flat: React.CSSProperties = {
    ...FACE,
    width: 130,
    height: 130,
    inset: 0,
  };

  return (
    <div
      className="unlock-box"
      style={{ width: 150, height: 150, perspective: "700px", flexShrink: 0 }}
    >
      <div
        style={{
          width: 130,
          height: 130,
          margin: 10,
          position: "relative",
          transformStyle: "preserve-3d",
          transform: "rotateX(-12deg) rotateY(-25deg)",
        }}
      >
        {/* Front face — lime fill, dark stroke, flor tile */}
        <div
          style={{
            ...side,
            background: LIME,
            border: `2px solid ${CARD}`,
            transform: "translateZ(65px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <svg
            aria-hidden
            viewBox="0 0 120 120"
            style={{ width: 40, height: 40, opacity: 0.55, flexShrink: 0 }}
            fill={CARD}
          >
            <path d={FLOR_PATH} fillRule="evenodd" clipRule="evenodd" />
          </svg>
        </div>

        {/* Right face — slightly darker lime */}
        <div
          style={{
            ...side,
            background: "rgba(160,194,16,0.92)",
            border: `1.5px solid ${CARD}`,
            transform: "rotateY(90deg) translateZ(65px)",
          }}
        />

        {/* Left face — same shade as right */}
        <div
          style={{
            ...side,
            background: "rgba(160,194,16,0.92)",
            border: `1.5px solid ${CARD}`,
            transform: "rotateY(-90deg) translateZ(65px)",
          }}
        />

        {/* Back face — dark inside wall, visible when lid opens */}
        <div
          style={{
            ...side,
            background: CARD,
            border: `1.5px solid rgba(255,255,255,0.06)`,
            transform: "translateZ(-65px)",
          }}
        />

        {/* Inside floor — dark with lime glow visible when lid opens */}
        <div
          className="unlock-box-glow"
          style={{
            ...flat,
            background:
              "radial-gradient(ellipse at 50% 55%, rgba(208,236,26,0.55) 0%, #093d1a 62%)",
            transform: "rotateX(90deg) translateZ(-45px)",
          }}
        />

        {/* Lid wrapper — hinge at back edge (local Y=0 in lid-wrapper space) */}
        <div
          style={{
            ...flat,
            transformStyle: "preserve-3d",
            transform: "rotateX(90deg) translateZ(48px)",
          }}
        >
          <div
            className="unlock-box-lid-face"
            style={{
              ...flat,
              background: `linear-gradient(175deg, ${LIME} 0%, rgba(190,228,14,0.95) 100%)`,
              border: `2px solid ${CARD}`,
              transformOrigin: "50% 0%",
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── source tile ───────────────────────────────────────────────────────────────

function SourceTile({
  label,
  src,
  small,
}: {
  label: string;
  src: string;
  small?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "grid place-items-center overflow-hidden bg-white",
        small ? "size-9 rounded-xl" : "size-14 rounded-2xl",
      )}
      style={{
        border: "1.5px solid rgba(120,113,108,0.1)",
        boxShadow: small
          ? "0 3px 10px rgba(0,0,0,0.22)"
          : "0 8px 24px rgba(0,0,0,0.28),0 2px 6px rgba(0,0,0,0.12)",
      }}
      title={label}
    >
      {failed ? (
        <span
          className={cn("font-medium", small ? "text-[10px]" : "text-sm")}
          style={{ color: CARD }}
        >
          {label[0]}
        </span>
      ) : (
        <img
          src={src}
          alt={label}
          className={cn("object-contain", small ? "size-5" : "size-9")}
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

/** Pill card representing a report output — flies out of the box. */
function ReportCard({ label, color }: { label: string; color: string }) {
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.97)",
        borderRadius: 20,
        padding: "7px 13px",
        display: "flex",
        alignItems: "center",
        gap: 7,
        boxShadow: "0 4px 16px rgba(0,0,0,0.26), 0 1px 3px rgba(0,0,0,0.1)",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 8,
          background: color,
          flexShrink: 0,
          display: "block",
        }}
      />
      <span
        style={{ fontSize: 13, fontWeight: 500, color: CARD, lineHeight: 1 }}
      >
        {label}
      </span>
    </div>
  );
}

/**
 * The unlock reveal. The box is the hero: it slides in, the lid flips open,
 * god-rays burst from the opening, and the integration icons fly out.
 */
function UnlockVisual({ active }: { active: boolean }) {
  // Replay the animation each time the slide re-enters — render-phase "state
  // from props" adjustment (no effect).
  const [prevActive, setPrevActive] = useState(active);
  const [playKey, setPlayKey] = useState(0);
  if (active !== prevActive) {
    setPrevActive(active);
    if (active) setPlayKey((k) => k + 1);
  }

  return (
    <div className="relative z-10 flex w-full shrink-0 items-center justify-center py-[min(0.5rem,0.8svh)] sm:py-4 lg:h-full lg:flex-1 lg:py-0">
      {/* Desktop: large flor tile bleeds off the right edge as brand texture */}
      <div className="pointer-events-none absolute inset-0 hidden overflow-visible lg:block">
        <div className="absolute left-[-5%] top-1/2 aspect-square h-[130%] -translate-y-1/2">
          <svg
            aria-hidden
            viewBox="0 0 120 120"
            className="h-full w-full"
            fill="#0c5122"
          >
            <path d={FLOR_PATH} fillRule="evenodd" clipRule="evenodd" />
          </svg>
        </div>
      </div>

      <div
        key={playKey}
        data-play={active && playKey > 0 ? "true" : "false"}
        className="relative z-10 flex flex-col items-center gap-2 lg:scale-[2] lg:origin-center [@media(max-height:780px)]:lg:scale-[1.4]"
      >
        {/*
         * Box + icons + rays all in a single relative container so every
         * absolute position is relative to the same 160×148 bounding box —
         * no drift on desktop where the outer flex container is wider.
         * DOM order: rays → halo → box → icons (later = paints on top).
         */}
        {/* height compresses on short viewports; the box is bottom-anchored and
            the flying cards sit above it, so everything stays inside. */}
        <div className="relative h-[min(240px,26svh)] w-[260px] sm:h-[240px]">
          {/* rays + halo: behind everything, anchored to box opening */}
          <div
            className="unlock-rays pointer-events-none absolute size-[360px] sm:size-[460px]"
            style={{
              bottom: 116,
              left: "50%",
              transform: "translateX(-50%)",
              background: RAYS_BG,
              maskImage: RAYS_MASK,
              WebkitMaskImage: RAYS_MASK,
            }}
          />
          <div
            className="unlock-halo pointer-events-none absolute size-[300px] rounded-full sm:size-[380px]"
            style={{
              bottom: 128,
              left: "50%",
              transform: "translateX(-50%)",
              background:
                "radial-gradient(circle, rgba(208,236,26,0.38), transparent 70%)",
            }}
          />

          {/* box anchored to bottom-center */}
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2">
            <BoxVisual />
          </div>

          {/* source icons — static, appear with the box at the base */}
          <div
            className="unlock-box-sources absolute left-1/2 -translate-x-1/2 flex items-center gap-2"
            style={{ bottom: 6 }}
          >
            {SOURCES.map((s) => (
              <SourceTile key={s.label} {...s} small />
            ))}
          </div>

          {/* report cards — fly out of the box, each at a natural angle */}
          <div
            className="absolute left-1/2 -translate-x-1/2 flex items-center gap-3"
            style={{ bottom: 128 }}
          >
            {REPORT_CARDS.map((card, i) => (
              <div
                key={card.label}
                style={{ transform: `rotate(${card.rotate}deg)` }}
              >
                <div
                  className="unlock-box-icon"
                  style={
                    {
                      animationDelay: `${1280 + i * 130}ms`,
                      "--icon-dx": ["-10px", "0px", "10px"][i],
                    } as React.CSSProperties
                  }
                >
                  <ReportCard label={card.label} color={card.color} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Closing CTA slide (always last). A dark-green card: the payoff headline +
 * benefit bullets on the left, the unlock reveal (brand-seal emblem + the data
 * sources we connect) on the right. Mobile-first — the card stacks with the
 * emblem on top; from `lg` it splits into two columns. The primary action lives
 * in the slide on desktop; on mobile the deck footer carries it.
 */
export default function CtaTemplate({ domain, active = false }: CtaProps) {
  const show = active ? "true" : "false";
  const ctaHref = useReportCtaHref(domain);
  return (
    <div className="h-full w-full sm:px-6 lg:px-10 sm:pb-2">
      <div
        className="relative flex h-full w-full flex-col gap-[min(1.75rem,2.8svh)] overflow-y-auto overflow-x-hidden rounded-none px-6 py-[min(1.5rem,2.2svh)] [justify-content:safe_center] sm:gap-0 sm:justify-start sm:overflow-hidden sm:rounded-3xl sm:p-8 lg:flex-row-reverse lg:items-stretch lg:p-12 [@media(max-height:780px)]:lg:p-8"
        style={{ background: CARD }}
      >
        {/* Mobile only: a LARGE `flor` backdrop across the top of the card that
            fades out before the headline. (Desktop uses the in-column tile in
            UnlockVisual instead.) */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[58%] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_28%,transparent_92%)] [-webkit-mask-image:linear-gradient(to_bottom,#000_28%,transparent_92%)] lg:hidden"
        >
          <svg
            viewBox="0 0 120 120"
            preserveAspectRatio="xMidYMid slice"
            className="absolute left-1/2 top-1/2 h-[135%] w-[135%] -translate-x-1/2 -translate-y-1/2"
            fill="#0c5122"
          >
            <path d={FLOR_PATH} fillRule="evenodd" clipRule="evenodd" />
          </svg>
        </div>

        {/* ── unlock visual (top on mobile, right on desktop) ── */}
        <UnlockVisual active={active} />

        {/* ── content (bottom on mobile, left on desktop) ── */}
        <div className="relative z-10 flex flex-col justify-center gap-[min(1rem,1.8svh)] sm:gap-5 lg:flex-1 lg:gap-10 lg:pr-8 [@media(max-height:780px)]:lg:gap-5">
          <h2
            className="reveal text-balance text-center font-normal leading-[1.08] tracking-[-0.02em] text-[min(clamp(1.6rem,4.4vw,2.75rem),3.4svh)] min-[390px]:text-[min(clamp(1.9rem,5vw,2.75rem),3.4svh)] sm:text-[clamp(1.9rem,5vw,2.75rem)] lg:text-left"
            data-show={show}
            style={{
              color: "#ffffff",
              transitionDelay: active ? "40ms" : "0ms",
            }}
          >
            {HEADLINE_LEAD}{" "}
            <span style={{ color: LIME }}>{HEADLINE_ACCENT}</span>
          </h2>

          <ul className="flex flex-col gap-1.5 min-[390px]:gap-3 sm:gap-5 lg:gap-6 [@media(max-height:780px)]:lg:gap-3">
            {BULLETS.map((bullet, i) => (
              <li
                key={bullet.label}
                className="reveal flex items-start gap-3.5"
                data-show={show}
                style={{
                  transitionDelay: active ? `${190 + i * 70}ms` : "0ms",
                }}
              >
                <span
                  className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg [@media(max-height:780px)]:lg:size-7 [@media(max-height:780px)]:lg:rounded-md"
                  style={{ background: bullet.color, color: CARD }}
                >
                  <Icon name={bullet.icon} size="large" />
                </span>
                <span className="flex min-w-0 flex-col">
                  <span
                    className="text-base min-[390px]:text-[17px] font-medium leading-snug [@media(max-height:780px)]:lg:text-[15px]"
                    style={{ color: "#ffffff" }}
                  >
                    {bullet.label}
                  </span>
                  {/* short viewports: clamp to one line so the bullets + the
                      visual + headline fit without scrolling */}
                  <span
                    className="text-[14px] min-[390px]:text-[15px] leading-snug [@media(max-height:820px)]:line-clamp-1"
                    style={{ color: "rgba(255,255,255,0.6)" }}
                  >
                    {bullet.desc}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          {/* Desktop: primary action lives in the slide (the footer CTA is
              mobile-only), so the card stays self-contained. */}
          <a
            href={ctaHref}
            onClick={(e) =>
              trackConnectCta(e, {
                domain,
                placement: "cta_slide_desktop",
                slideKey: "cta",
              })
            }
            className="reveal mt-1 hidden h-12 shrink-0 items-center gap-2 self-start whitespace-nowrap rounded-full px-7 text-base font-medium transition-transform hover:scale-[1.02] lg:mt-3 lg:inline-flex"
            data-show={show}
            style={{
              background: LIME,
              color: LIME_INK,
              transitionDelay: active ? "480ms" : "0ms",
            }}
          >
            <span>{CTA_LABEL}</span>
            <Icon name="arrow_forward" size="medium" />
          </a>
        </div>
      </div>
    </div>
  );
}
