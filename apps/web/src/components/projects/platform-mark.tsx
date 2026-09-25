/**
 * A commerce platform's mark and name.
 *
 * The logo comes from the platform's own favicon, the way the report deck
 * already sources its data-source logos (`routes/reports/source-logos.ts`) —
 * real marks, no asset pipeline, no license file per vendor. The tile carries
 * its own frame and the logo sits inside it, so a circular favicon does not
 * make its row read as a different shape from its neighbours. When the fetch
 * fails the tile falls back to a neutral glyph rather than a broken image, so
 * an offline dev session still reads correctly.
 */

import { useState } from "react";
import { Building05 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/use-t.ts";
import type { CommercePlatform } from "@/lib/project-profile.ts";

interface PlatformMeta {
  labelKey: TranslationKey;
  /** Domain whose favicon stands in for the mark. */
  domain: string;
}

const PLATFORM_META: Record<CommercePlatform, PlatformMeta> = {
  vtex: { labelKey: "projects.platform.vtex", domain: "vtex.com" },
  shopify: { labelKey: "projects.platform.shopify", domain: "shopify.com" },
  wake: { labelKey: "projects.platform.wake", domain: "wake.tech" },
  nuvemshop: {
    labelKey: "projects.platform.nuvemshop",
    domain: "nuvemshop.com.br",
  },
  linx: { labelKey: "projects.platform.linx", domain: "linx.com.br" },
  vnda: { labelKey: "projects.platform.vnda", domain: "vnda.com.br" },
};

const SIZES = {
  /** The inset is part of the size: a fixed one leaves the logo cramped in the
   *  small tile and adrift in the large one. */
  sm: "size-5 rounded-[5px] p-0.5 text-[10px]",
  md: "size-8 rounded-lg p-1 text-xs",
  lg: "size-10 rounded-xl p-1.5 text-sm",
} as const;

export function PlatformMark({
  platform,
  size = "md",
  className,
}: {
  platform: CommercePlatform;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const t = useT();
  const meta = PLATFORM_META[platform];
  const [failed, setFailed] = useState(false);
  const label = t(meta.labelKey);

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden border border-border bg-card font-medium text-muted-foreground",
        SIZES[size],
        className,
      )}
      title={label}
    >
      {!failed ? (
        <img
          src={`https://www.google.com/s2/favicons?domain=${meta.domain}&sz=64`}
          alt=""
          aria-hidden
          /* Inset, so the TILE is the shape and the logo is content inside
             it. Some of these favicons are circles on a transparent background
             (Nuvemshop, VNDA) and some are squares; without a frame of its own
             the mark took the artwork's silhouette and the row came out in two
             different shapes. Scaling the artwork to fill instead would crop a
             round logo to a coloured square. */
          className="size-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Building05 className="size-1/2" aria-hidden />
      )}
    </span>
  );
}
