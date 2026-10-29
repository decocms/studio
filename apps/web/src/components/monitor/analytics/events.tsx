/**
 * Events & properties: the custom events a site sends, the values of any
 * property it sends with them, and what the engagement module measures on its
 * own (scroll depth, site search, outbound links, downloads).
 */

import { CursorClick01 } from "@untitledui/icons";
import { Chip } from "@decocms/ui/components/chip.tsx";
import { useT } from "@/i18n/use-t.ts";
import { useAnalyticsSegment } from "./segment";
import {
  fmtInt,
  kn,
  NoRows,
  n0,
  Panel,
  RankedList,
  RankedRows,
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
      <div className="grid gap-4 md:grid-cols-2">
        <RankedList
          title={t("monitor.analytics.panels.events")}
          rows={kn(rowsOf(data, "events"))}
          dim="name"
          limit={12}
        />
        <Properties
          keys={kn(rowsOf(data, "propKeys"))}
          values={kn(rowsOf(data, "propValues"))}
          selected={props.segment.prop}
        />
      </div>
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

/**
 * Every property key the site sends, as a chooser that wraps (keys are the
 * site's own names and can be long), then the chosen key's values. A value
 * row filters on `key=value`.
 */
function Properties({
  keys,
  values,
  selected,
}: {
  keys: { k: string; n: number }[];
  values: { k: string; n: number }[];
  selected: string | undefined;
}) {
  const t = useT();
  const { setSegment } = useAnalyticsSegment();
  const title = t("monitor.analytics.panels.properties");
  if (keys.length === 0) {
    return (
      <Panel title={title}>
        <NoRows />
      </Panel>
    );
  }
  return (
    <Panel title={title}>
      <div className="flex flex-col gap-5">
        <div
          role="radiogroup"
          aria-label={title}
          className="flex flex-wrap gap-1.5"
        >
          {keys.map((key) => (
            <Chip key={key.k} asChild>
              <button
                type="button"
                role="radio"
                aria-checked={selected === key.k}
                title={t("monitor.analytics.panels.propUses", {
                  n: fmtInt(key.n),
                })}
                onClick={() =>
                  setSegment({
                    prop: selected === key.k ? undefined : key.k,
                  })
                }
                className="font-mono aria-checked:bg-foreground aria-checked:text-background aria-checked:hover:bg-foreground/90"
              >
                {key.k}
              </button>
            </Chip>
          ))}
        </div>
        {selected ? (
          <RankedRows
            rows={values}
            dim="prop"
            filterValue={(k) => `${selected}=${k}`}
            limit={10}
          />
        ) : (
          <p className="text-meta">
            {t("monitor.analytics.panels.pickProperty")}
          </p>
        )}
      </div>
    </Panel>
  );
}
