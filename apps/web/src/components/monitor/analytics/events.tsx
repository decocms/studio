/**
 * Events: the custom events a site sends, and what the engagement module
 * measures on its own (scroll depth, site search, outbound links, downloads).
 */

import { CursorClick01 } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import {
  fmtInt,
  kn,
  n0,
  RankedList,
  rowsOf,
  SectionEmpty,
  SectionError,
  SectionSkeleton,
  str,
  useSectionView,
} from "./panels";
import type { SectionProps } from "./types";

export function EventsSection(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "events");
  if (view.isLoading) return <SectionSkeleton />;
  if (view.error) return <SectionError error={view.error} />;
  const data = view.data;

  const scroll = kn(rowsOf(data, "scrollDepth"));
  const searches = rowsOf(data, "searches").map((r) => ({
    k: str(r.k),
    n: n0(r.n),
    visitors: n0(r.visitors),
  }));
  const outbound = kn(rowsOf(data, "outbound"));
  const downloads = kn(rowsOf(data, "downloads"));
  const engagement =
    scroll.length + searches.length + outbound.length + downloads.length > 0;
  const propFilter = (key: string) => (k: string) => `${key}=${k}`;

  return (
    <>
      <RankedList
        title={t("monitor.analytics.panels.events")}
        rows={kn(rowsOf(data, "events"))}
        dim="name"
        limit={12}
      />
      {engagement ? (
        <div className="grid gap-4 md:grid-cols-2">
          <RankedList
            title={t("monitor.analytics.panels.scrollDepth")}
            rows={scroll}
            dim="prop"
            filterValue={propFilter("depth")}
            label={(k) =>
              t("monitor.analytics.panels.scrollReached", { pct: k })
            }
            share={false}
          />
          <RankedList
            title={t("monitor.analytics.panels.searches")}
            rows={searches}
            dim="prop"
            filterValue={propFilter("term")}
            extra={(r) =>
              "visitors" in r
                ? t("monitor.analytics.panels.visitorsShort", {
                    n: fmtInt(r.visitors),
                  })
                : null
            }
          />
          <RankedList
            title={t("monitor.analytics.panels.outbound")}
            rows={outbound}
            dim="prop"
            filterValue={propFilter("target")}
          />
          <RankedList
            title={t("monitor.analytics.panels.downloads")}
            rows={downloads}
            dim="prop"
            filterValue={propFilter("target")}
          />
        </div>
      ) : (
        <SectionEmpty
          icon={<CursorClick01 size={20} />}
          title={t("monitor.analytics.panels.engagementOff")}
          description={t("monitor.analytics.panels.engagementOffDesc")}
        />
      )}
    </>
  );
}
