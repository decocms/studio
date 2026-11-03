import type { ReactNode } from "react";
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
import { cn } from "@decocms/ui/lib/utils.ts";
import { IntegrationIcon } from "@/components/integration-icon";
import { type TranslationKey, useT } from "@/i18n/use-t.ts";
import { useConnections } from "@/sdk";
import { EvidenceDetail, EvidenceLink } from "./evidence-detail";
import { ExpandableGrid } from "./expandable-grid";

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

/** A fact longer than this is cut on the small card, so the card opens to show it whole. */
const SHORT_FACT = 140;

/** A system's logo from its connection, in color; the line icon for the rest. */
function SourceIcon({
  source,
  icon,
  label,
}: {
  source: BlogEvidenceSource;
  icon: string | null | undefined;
  label: string;
}) {
  const Icon = SOURCE_ICON[source];
  const line = <Icon size={12} className="text-muted-foreground" />;
  return icon ? (
    <IntegrationIcon
      icon={icon}
      name={label}
      size="xs"
      fit="contain"
      className="rounded-md p-[3px]"
      fallbackIcon={line}
    />
  ) : (
    <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-card">
      {line}
    </span>
  );
}

/** A system's icon on its own, such as the source a briefing stands on. */
export function EvidenceSourceIcon({ source }: { source: BlogEvidenceSource }) {
  const t = useT();
  const connections = useConnections();
  const icon =
    source === "gsc" || source === "ga4" || source === "vtex"
      ? pickBlogConnection(source, connections)?.icon
      : null;
  return (
    <SourceIcon source={source} icon={icon} label={t(SOURCE_LABEL[source])} />
  );
}

function SourceHeader({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="mb-[9px] flex items-center gap-[7px]">
      {icon}
      <span className="text-[11.5px] font-semibold text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

/**
 * What the store's systems reported: a small card per system with its
 * strongest figure, opening to everything it said and the data behind it.
 */
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
    <ExpandableGrid
      items={sources.map((source) => {
        const label = t(SOURCE_LABEL[source]);
        const appIcon =
          source === "gsc" || source === "ga4" || source === "vtex"
            ? pickBlogConnection(source, connections)?.icon
            : null;
        const header = (
          <SourceHeader
            icon={<SourceIcon source={source} icon={appIcon} label={label} />}
            label={label}
          />
        );
        const [first, ...rest] = evidence.filter(
          (item) => item.source === source,
        );
        if (!first) {
          return {
            id: source,
            muted: true,
            detail: null,
            summary: () => (
              <>
                {header}
                <p className="text-xs text-muted-foreground">
                  {source === "gsc" && !gscConnected
                    ? t("contentTrack.card.notConnected")
                    : t("contentTrack.card.noSignal")}
                </p>
              </>
            ),
          };
        }
        const hasDetail = rest.length > 0 || !!first.detail || !!first.tool;
        return {
          id: source,
          opens: hasDetail || first.fact.length > SHORT_FACT,
          summary: (open: boolean) => (
            <>
              {header}
              {first.figure && (
                <div className="mb-[3px] text-[15px] font-semibold tracking-[-0.01em] text-foreground tabular-nums">
                  {first.figure}
                </div>
              )}
              <p
                className={cn(
                  first.figure
                    ? "text-xs leading-[1.42] text-muted-foreground"
                    : "text-[13px] leading-[1.45] text-foreground",
                  !open && "line-clamp-2",
                )}
              >
                {first.fact}
              </p>
              {!open && rest.length > 0 && (
                <span className="mt-2 block text-[11.5px] text-muted-foreground">
                  {t("contentTrack.card.moreSignals", { count: rest.length })}
                </span>
              )}
            </>
          ),
          detail: hasDetail ? (
            <div className="flex flex-col gap-3.5">
              {first.detail && <EvidenceDetail detail={first.detail} />}
              {rest.length > 0 && (
                <ul className="flex flex-col gap-2.5">
                  {rest.map((item, index) => (
                    <li
                      key={index}
                      className="flex flex-col gap-2 text-xs leading-[1.42] text-muted-foreground"
                    >
                      <span>
                        {item.figure && (
                          <span className="font-semibold text-foreground tabular-nums">
                            {item.figure}{" "}
                          </span>
                        )}
                        {item.fact}
                      </span>
                      {item.detail && <EvidenceDetail detail={item.detail} />}
                    </li>
                  ))}
                </ul>
              )}
              <EvidenceLink
                link={first.detail?.link}
                fallbackLabel={t("contentTrack.card.openIn", { source: label })}
              />
              {first.tool && (
                <span className="text-[11px] text-muted-foreground">
                  {t("contentTrack.card.viaTool", { tool: first.tool })}
                </span>
              )}
            </div>
          ) : null,
        };
      })}
    />
  );
}
