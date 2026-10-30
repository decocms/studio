import {
  BarChart07,
  Calendar,
  Package,
  SearchMd,
  Star01,
} from "@untitledui/icons";
import type {
  BlogEvidence,
  BlogEvidenceSource,
} from "@decocms/shared/blog-card";
import { pickBlogConnection } from "@decocms/shared/blog-connections";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";
import { useConnections } from "@/sdk";

const SOURCE_LABEL = {
  gsc: "contentTrack.card.source.gsc",
  ga4: "contentTrack.card.source.ga4",
  vtex: "contentTrack.card.source.vtex",
  calendar: "contentTrack.card.source.calendar",
  brand: "contentTrack.card.source.brand",
} as const satisfies Record<BlogEvidenceSource, TranslationKey>;

const SOURCE_ICON = {
  gsc: SearchMd,
  ga4: BarChart07,
  vtex: Package,
  calendar: Calendar,
  brand: Star01,
} as const satisfies Record<BlogEvidenceSource, unknown>;

/** The four systems evidence is read against, always shown. */
const SIGNALS = ["gsc", "ga4", "vtex", "calendar"] as const;

/** What the store's systems reported, one box per system, the strongest figure first. */
export function EvidenceBySource({
  evidence,
}: {
  evidence: readonly BlogEvidence[];
}) {
  const t = useT();
  const connections = useConnections();
  const gscConnected = !!pickBlogConnection("gsc", connections);
  const sources = evidence.some((item) => item.source === "brand")
    ? [...SIGNALS, "brand" as const]
    : SIGNALS;

  return (
    <div className="grid gap-[9px] sm:grid-cols-2">
      {sources.map((source) => {
        const [first, ...rest] = evidence.filter(
          (item) => item.source === source,
        );
        const Icon = SOURCE_ICON[source];
        return (
          <div
            key={source}
            className="rounded-[11px] border border-border bg-card px-[13px] py-3"
          >
            <div className="mb-[9px] flex items-center gap-[7px]">
              <span className="grid size-[22px] shrink-0 place-items-center rounded-md border border-border bg-card text-muted-foreground">
                <Icon size={12} />
              </span>
              <span className="text-[11.5px] font-semibold text-muted-foreground">
                {t(SOURCE_LABEL[source])}
              </span>
            </div>
            {first ? (
              <>
                {first.figure ? (
                  <>
                    <div className="mb-[3px] text-[15px] font-semibold tracking-[-0.01em] text-foreground tabular-nums">
                      {first.figure}
                    </div>
                    <p className="text-xs leading-[1.42] text-muted-foreground">
                      {first.fact}
                    </p>
                  </>
                ) : (
                  <p className="text-[13px] leading-[1.45] text-foreground">
                    {first.fact}
                  </p>
                )}
                {rest.length > 0 && (
                  <ul className="mt-2.5 flex flex-col gap-2 border-t border-border pt-2.5">
                    {rest.map((item, index) => (
                      <li
                        key={index}
                        className="text-xs leading-[1.42] text-muted-foreground"
                      >
                        {item.figure && (
                          <span className="font-semibold text-foreground tabular-nums">
                            {item.figure}{" "}
                          </span>
                        )}
                        {item.fact}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {source === "gsc" && !gscConnected
                  ? t("contentTrack.card.notConnected")
                  : t("contentTrack.card.noSignal")}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
