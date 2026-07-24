import { cn } from "@deco/ui/lib/utils.ts";
import { useState } from "react";
import Icon from "../icon";
import SlideHeader from "./slide-header";
import { DECK } from "./tokens";
import type { ProductsProps } from "@decocms/shared/reports/deck-types";

// Podium medals — gold/silver/bronze for 1/2/3. Ranks 4+ get a plain index chip.
const MEDAL: Record<number, string> = {
  1: "#c8a24b",
  2: "#9aa0a6",
  3: "#b07a48",
};

/** One product card — the lp2 tile idiom: white, hairline border (no heavy drop
 *  shadow), square image over a name in ink and a promoted price. A soft lift on
 *  hover only. */
function ProductCard({
  product,
  rank,
  active,
  delay,
}: {
  product: { name: string; price?: string; image?: string; url?: string };
  rank: number;
  active: boolean;
  delay: number;
}) {
  const [imgOk, setImgOk] = useState(Boolean(product.image));
  const medal = MEDAL[rank];

  return (
    <div
      className="reveal group flex w-[52vw] max-w-[210px] shrink-0 snap-center flex-col rounded-xl border bg-white p-1.5 transition-shadow duration-500 hover:shadow-[0_20px_44px_-24px_rgba(40,37,36,0.32)] sm:w-auto sm:max-w-none sm:shrink sm:snap-align-none"
      data-show={active ? "true" : "false"}
      style={{
        borderColor: DECK.cardBorder,
        transitionDelay: active ? `${delay}ms` : "0ms",
      }}
    >
      {/* 3:4 portrait thumb, inset 6px inside the card (the card's p-1.5) with a
          concentric 6px radius — a small padded frame around the product shot. */}
      <div
        className="relative aspect-[3/4] w-full overflow-hidden rounded-md"
        style={{ background: "#f6f4f1" }}
      >
        {imgOk && product.image ? (
          <img
            src={product.image}
            alt={product.name}
            className="h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.04]"
            loading="lazy"
            onError={() => setImgOk(false)}
          />
        ) : (
          <span className="grid h-full w-full place-items-center">
            <Icon name="package_2" size="xxl" class="opacity-15" />
          </span>
        )}
        {/* Rank chip — medal-filled for the podium, hairline pill otherwise. */}
        <span
          className="absolute left-2 top-2 inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium tabular-nums"
          style={
            medal
              ? { background: medal, color: "#fff" }
              : {
                  background: "rgba(255,255,255,0.92)",
                  color: DECK.muted,
                  border: `1px solid ${DECK.cardBorder}`,
                }
          }
        >
          #{rank}
        </span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-1.5 pb-1 pt-2.5">
        <span
          className="line-clamp-2 min-w-0 text-[13px] leading-snug sm:text-[13.5px]"
          style={{ color: DECK.ink }}
        >
          {product.name}
        </span>
        {product.price && (
          <span
            className="mt-auto pt-1 text-[15px] font-medium tabular-nums tracking-[-0.01em] sm:text-[17px]"
            style={{ color: DECK.ink }}
          >
            {product.price}
          </span>
        )}
      </div>
    </div>
  );
}

// Even columns that fill the width (no lopsided right gap) — column count
// matches the item count on desktop so the row fills evenly. Mobile is a
// horizontal snap carousel instead of a grid. 6 items go 3-up on tablet,
// 6-up on desktop.
function gridColsClass(n: number): string {
  if (n <= 2) return "sm:grid-cols-2";
  if (n === 3) return "sm:grid-cols-3";
  if (n === 4) return "sm:grid-cols-4";
  if (n === 5) return "sm:grid-cols-5";
  return "sm:grid-cols-3 lg:grid-cols-6";
}

/**
 * Best-sellers showcase — a catalog wall of the store's top products. Borderless
 * cards with a soft lift. Mobile: a horizontal snap carousel (one big card with
 * the next peeking, all products reachable). Desktop: an even grid that fills
 * the width (columns = item count). Framed as catalog strength.
 */
export default function ProductsTemplate({
  eyebrow,
  headline,
  annotation,
  products,
  active = false,
}: ProductsProps) {
  const shown = products.slice(0, 6);

  return (
    <div className="flex h-full flex-col">
      <SlideHeader
        eyebrow={eyebrow}
        headline={headline}
        annotation={annotation}
        active={active}
      />

      <div className="flex min-h-0 flex-1 flex-col justify-center pt-4 sm:px-10 sm:pt-12 lg:px-16">
        {/* Mobile: edge-to-edge snap carousel (SignalDeck exempts horizontal
            scrollers from slide navigation). Desktop: the original grid. */}
        <div
          className={cn(
            "flex w-full snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-5 scroll-px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:grid sm:snap-none sm:gap-4 sm:overflow-x-visible sm:px-0",
            gridColsClass(shown.length),
          )}
        >
          {shown.map((p, i) => (
            <ProductCard
              key={i}
              product={p}
              rank={i + 1}
              active={active}
              delay={60 + i * 55}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
