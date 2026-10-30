import type { ReactNode } from "react";
import type { CampaignProduct } from "@/components/sandbox/content/blog/blog-data";
import { useT } from "@/i18n/use-t.ts";

/** A shelf of products as a reader sees it: a title, how many, and each one's photograph and name. */
export function ProductShelf({
  title,
  products,
}: {
  title: ReactNode;
  products: readonly CampaignProduct[];
}) {
  const t = useT();
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="mb-[11px] flex items-baseline justify-between gap-3">
        <span className="text-[13.5px] font-semibold text-foreground">
          {title}
        </span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground">
          {t("contentTrack.card.shelfCount", { count: products.length })}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {products.map((product) => (
          <div
            key={product.id || product.name}
            className="flex flex-col overflow-hidden rounded-[10px] border border-border bg-card"
          >
            {product.images[0] ? (
              <img
                src={product.images[0]}
                alt={product.name}
                className="aspect-square w-full object-cover"
              />
            ) : (
              <div className="aspect-square w-full bg-muted" />
            )}
            <span className="line-clamp-2 px-[9px] pt-2 pb-[9px] text-xs font-medium text-foreground">
              {product.name}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
