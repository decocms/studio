/**
 * Data quality: what the collector had to adjust about what the site sent,
 * where rows came from, the bot share, and the names and properties the site
 * sends without declaring them. Nothing here was dropped; adjusted events are
 * stored and marked.
 */

import { Badge } from "@decocms/ui/components/badge.tsx";
import { useT } from "@/i18n/use-t.ts";
import {
  type Column,
  FilterKey,
  firstRow,
  fmtInt,
  fmtPct,
  fmtWhen,
  n0,
  num,
  Panel,
  PanelTable,
  RankedList,
  type Row,
  rowsOf,
  SectionError,
  SectionSkeleton,
  str,
  useSectionView,
} from "./panels";
import type { SectionProps } from "./types";

/** Above this, a property's values are nearly all distinct: an id, not a dimension. */
const ID_LIKE_RATIO = 0.5;

const mono = (s: string) => <span className="font-mono text-xs">{s}</span>;

export function QualitySection(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "quality");
  if (view.isLoading) return <SectionSkeleton tiles={3} />;
  if (view.error) return <SectionError error={view.error} />;
  const data = view.data;

  const flags = rowsOf(data, "quality");
  const adjusted = flags.reduce((a, r) => a + n0(r.n), 0);
  const bots = firstRow(data, "botShare");
  const trust = rowsOf(data, "trust");
  const trustTotal = trust.reduce((a, r) => a + n0(r.n), 0);
  const tag = trust.find((r) => str(r.k) === "tag");

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Panel
          title={t("monitor.analytics.panels.quality.adjusted")}
          value={fmtInt(adjusted)}
          caption={
            adjusted === 0 ? (
              <Badge variant="success" className="w-fit">
                {t("monitor.analytics.panels.quality.inContract")}
              </Badge>
            ) : undefined
          }
        />
        <Panel
          title={t("monitor.analytics.panels.quality.botShare")}
          value={fmtPct(num(bots?.pct), 1)}
          caption={
            bots && (
              <span className="text-meta tnum">
                {t("monitor.analytics.panels.quality.botVisitors", {
                  n: fmtInt(bots.bot_visitors),
                })}
              </span>
            )
          }
        />
        <Panel
          title={t("monitor.analytics.panels.quality.unverified")}
          value={fmtPct(trustTotal ? (100 * n0(tag?.n)) / trustTotal : null, 1)}
          caption={
            <span className="text-meta tnum">
              {t("monitor.analytics.panels.quality.events", {
                n: fmtInt(tag?.n ?? 0),
              })}
            </span>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <RankedList
          title={t("monitor.analytics.panels.quality.flags")}
          rows={flags.map((r) => ({ k: str(r.flag), n: n0(r.n) }))}
          dim="flag"
          label={mono}
          extra={(r) =>
            fmtPct(num(flags.find((f) => str(f.flag) === r.k)?.pct), 2)
          }
          share={false}
        />
        <Origin rows={trust} />
      </div>

      <FlagEvents rows={rowsOf(data, "flagEvents")} />

      <div className="grid gap-4 lg:grid-cols-2">
        <UnregisteredEvents rows={rowsOf(data, "unregisteredEvents")} />
        <UnregisteredProps rows={rowsOf(data, "unregisteredProps")} />
      </div>

      <Cardinality rows={rowsOf(data, "propCardinality")} />
    </>
  );
}

/** `host` is resolved from the request and cannot be forged by the page; `tag` comes from a public key. */
function Origin({ rows }: { rows: Row[] }) {
  const t = useT();
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.quality.source"),
      cell: (r) => mono(str(r.k)),
    },
    {
      id: "n",
      header: t("monitor.analytics.panels.col.events"),
      numeric: true,
      cell: (r) => fmtInt(r.n),
    },
    {
      id: "verified",
      header: t("monitor.analytics.panels.quality.verified"),
      numeric: true,
      cell: (r) =>
        str(r.k) === "host" ? (
          <Badge variant="success">
            {t("monitor.analytics.panels.quality.yes")}
          </Badge>
        ) : (
          <Badge variant="warning">
            {t("monitor.analytics.panels.quality.no")}
          </Badge>
        ),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.quality.origin")}>
      <PanelTable columns={columns} rows={rows} rowKey={(r) => str(r.k)} />
    </Panel>
  );
}

function FlagEvents({ rows }: { rows: Row[] }) {
  const t = useT();
  if (rows.length === 0) return null;
  const columns: Column<Row>[] = [
    {
      id: "flag",
      header: t("monitor.analytics.panels.quality.flag"),
      cell: (r) => mono(str(r.flag)),
    },
    {
      id: "k",
      header: t("monitor.analytics.panels.col.event"),
      cell: (r) => <FilterKey>{mono(str(r.k))}</FilterKey>,
    },
    {
      id: "n",
      header: t("monitor.analytics.panels.col.events"),
      numeric: true,
      cell: (r) => fmtInt(r.n),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.quality.flagEvents")}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${str(r.flag)}/${str(r.k)}`}
        filter={(r) => ({ d: "name", v: str(r.k) })}
      />
    </Panel>
  );
}

function UnregisteredEvents({ rows }: { rows: Row[] }) {
  const t = useT();
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.col.event"),
      cell: (r) => <FilterKey>{mono(str(r.k))}</FilterKey>,
    },
    {
      id: "n",
      header: t("monitor.analytics.panels.col.events"),
      numeric: true,
      cell: (r) => fmtInt(r.n),
    },
    {
      id: "visitors",
      header: t("monitor.analytics.panels.col.visitors"),
      numeric: true,
      cell: (r) => fmtInt(r.visitors),
    },
    {
      id: "last",
      header: t("monitor.analytics.panels.errors.lastSeen"),
      numeric: true,
      className: "text-muted-foreground",
      cell: (r) => fmtWhen(r.last_seen),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.quality.unregisteredEvents")}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => str(r.k)}
        filter={(r) => ({ d: "name", v: str(r.k) })}
      />
    </Panel>
  );
}

function UnregisteredProps({ rows }: { rows: Row[] }) {
  const t = useT();
  const columns: Column<Row>[] = [
    {
      id: "event",
      header: t("monitor.analytics.panels.col.event"),
      cell: (r) => mono(str(r.event)),
    },
    {
      id: "k",
      header: t("monitor.analytics.panels.quality.property"),
      cell: (r) => mono(str(r.k)),
    },
    {
      id: "n",
      header: t("monitor.analytics.panels.col.events"),
      numeric: true,
      cell: (r) => fmtInt(r.n),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.quality.unregisteredProps")}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => `${str(r.event)}/${str(r.k)}`}
      />
    </Panel>
  );
}

function Cardinality({ rows }: { rows: Row[] }) {
  const t = useT();
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.quality.property"),
      cell: (r) => (
        <span className="flex items-center gap-2">
          {mono(str(r.k))}
          {n0(r.ratio) > ID_LIKE_RATIO && (
            <Badge variant="warning">
              {t("monitor.analytics.panels.quality.idLike")}
            </Badge>
          )}
        </span>
      ),
    },
    {
      id: "distinct",
      header: t("monitor.analytics.panels.quality.distinct"),
      numeric: true,
      cell: (r) => fmtInt(r.distinct_values),
    },
    {
      id: "uses",
      header: t("monitor.analytics.panels.quality.uses"),
      numeric: true,
      cell: (r) => fmtInt(r.uses),
    },
    {
      id: "ratio",
      header: t("monitor.analytics.panels.quality.ratio"),
      numeric: true,
      cell: (r) => fmtPct(100 * n0(r.ratio), 1),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.quality.cardinality")}>
      <PanelTable columns={columns} rows={rows} rowKey={(r) => str(r.k)} />
    </Panel>
  );
}
