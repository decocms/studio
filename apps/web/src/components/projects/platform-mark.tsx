/**
 * A commerce platform's mark and name. The logo is the platform's own favicon,
 * as in `routes/reports/source-logos.ts` — no asset pipeline, no license file
 * per vendor.
 *
 * The TILE carries the frame so a circular favicon does not change its row's
 * shape, and a failed fetch falls back to a neutral glyph.
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
  /** Part of the size: a fixed inset is cramped small and adrift large. */
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
          /* `object-contain`, so the tile is the shape: these favicons are circles and squares, and filling would crop a round logo. */
          className="size-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <Building05 className="size-1/2" aria-hidden />
      )}
    </span>
  );
}
