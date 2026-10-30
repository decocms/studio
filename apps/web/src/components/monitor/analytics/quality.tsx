/**
 * Data quality: the bot share, where the site id came from, what the
 * collector had to adjust about what the site sent, and the names and
 * properties it sends without declaring them. Nothing here was dropped;
 * adjusted events are stored and marked.
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
  kn,
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
  if (view.isLoading) return <SectionSkeleton tiles={4} />;
  if (view.error) return <SectionError error={view.error} />;
  const data = view.data;

  const flags = rowsOf(data, "quality");
  const bots = firstRow(data, "botShare");

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Panel
          title={t("monitor.analytics.panels.quality.bots")}
          value={fmtInt(bots?.bots)}
        />
        <Panel
          title={t("monitor.analytics.panels.quality.totalEvents")}
          value={fmtInt(bots?.events)}
        />
        <Panel
          title={t("monitor.analytics.panels.quality.botShare")}
          value={fmtPct(num(bots?.pct), 1)}
        />
        <Panel
          title={t("monitor.analytics.panels.quality.botVisitors")}
          value={fmtInt(bots?.bot_visitors)}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <RankedList
          title={t("monitor.analytics.panels.quality.origin")}
          rows={kn(rowsOf(data, "trust"))}
          label={mono}
        />
        <FlagEvents rows={rowsOf(data, "flagEvents")} />
        <RankedList
          title={t("monitor.analytics.panels.quality.flags")}
          rows={flags.map((r) => ({ k: str(r.flag), n: n0(r.n) }))}
          dim="flag"
          label={mono}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <UnregisteredEvents rows={rowsOf(data, "unregisteredEvents")} />
        <UnregisteredProps rows={rowsOf(data, "unregisteredProps")} />
      </div>

      <Cardinality rows={rowsOf(data, "propCardinality")} />
    </>
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
