import { useState } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { DECK } from "./templates/tokens";

// Intrinsic pixel dimensions keep SVGs with preserveAspectRatio="none" from
// stretching when they are rendered inside the carousel cells.
const CAROUSEL_LOGOS = [
  { src: "/logos/summit/fila.svg", alt: "Fila", w: 100, h: 34 },
  { src: "/logos/summit/osklen.svg", alt: "Osklen", w: 152, h: 21 },
  { src: "/logos/summit/farm-rio.svg", alt: "Farm Rio", w: 159, h: 23 },
  { src: "/logos/summit/electrolux.svg", alt: "Electrolux", w: 154, h: 35 },
  { src: "/logos/summit/monte-carlo.svg", alt: "Monte Carlo", w: 116, h: 61 },
  { src: "/logos/summit/technos.svg", alt: "Technos", w: 141, h: 29 },
  { src: "/logos/summit/bagaggio.svg", alt: "Bagaggio", w: 149, h: 22 },
  { src: "/logos/summit/le-biscuit.svg", alt: "Le Biscuit", w: 141, h: 24 },
  { src: "/logos/summit/miess.svg", alt: "Miess", w: 113, h: 43 },
  {
    src: "/logos/summit/casa-e-video.svg",
    alt: "Casa & Video",
    w: 145,
    h: 18,
  },
  { src: "/logos/summit/hering-fill.svg", alt: "Hering", w: 140, h: 30 },
] as const;

const CAROUSEL_COLS = 4;
const CYCLE_MS = 2400;

type LogoEntry = (typeof CAROUSEL_LOGOS)[number];

function splitLogos(n: number): LogoEntry[][] {
  const cols: LogoEntry[][] = Array.from({ length: n }, () => []);
  CAROUSEL_LOGOS.forEach((logo, index) => cols[index % n]?.push(logo));
  return cols;
}

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
  const [index, setIndex] = useState(0);

  const cycleRef = (element: HTMLDivElement | null) => {
    if (!element) return;
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      interval = setInterval(
        () => setIndex((current) => (current + 1) % logos.length),
        CYCLE_MS,
      );
    }, delayMs);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  };

  const logo = logos[index % logos.length] ?? logos[0];
  if (!logo) return null;

  const maxWidth = 78;
  const maxHeight = 22;
  const scale = Math.min(maxWidth / logo.w, maxHeight / logo.h);
  const renderWidth = Math.round(logo.w * scale);
  const renderHeight = Math.round(logo.h * scale);

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
        key={index}
        src={logo.src}
        alt={logo.alt}
        width={renderWidth}
        height={renderHeight}
        className="logo-carousel-enter block"
      />
    </div>
  );
}

function LogoCarousel() {
  const cols = splitLogos(CAROUSEL_COLS);

  return (
    <>
      <div
        className="grid grid-cols-2 overflow-hidden rounded-xl sm:hidden"
        style={{ border: `1px solid ${DECK.border}` }}
      >
        {cols.map((logos, index) => (
          <LogoCol
            key={logos[0]?.src}
            logos={logos}
            delayMs={index * 380}
            last={index % 2 === 1}
            bottomRow={index >= 2}
          />
        ))}
      </div>
      <div
        className="hidden overflow-hidden rounded-xl sm:flex"
        style={{ border: `1px solid ${DECK.border}` }}
      >
        {cols.map((logos, index) => (
          <LogoCol
            key={logos[0]?.src}
            logos={logos}
            delayMs={index * 380}
            last={index === cols.length - 1}
          />
        ))}
      </div>
    </>
  );
}

export function ReportSocialProof({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(compact ? "mt-5 pt-5" : "mt-8 pt-6")}
      style={{ borderTop: `1px solid ${DECK.border}` }}
    >
      <p
        className="mb-4 text-center text-[11px] uppercase tracking-[0.04em]"
        style={{ color: DECK.faint }}
      >
        Já receberam
      </p>
      <LogoCarousel />
    </div>
  );
}
