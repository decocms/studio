/**
 * Pages & sources: how visitors arrive, where they land and leave, what they
 * do with products and who they are. Every breakdown filters the segment on
 * its own dimension.
 */

import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import {
  capitalize,
  type Column,
  countryLabel,
  FilterKey,
  fmtInt,
  fmtMoney,
  fmtPct,
  Group,
  kn,
  moneyOf,
  n0,
  num,
  Panel,
  PanelTable,
  RankedList,
  type Row,
  rowsOf,
  SectionError,
  SectionSkeleton,
  splitRows,
  str,
  useSectionView,
  WithheldBadge,
} from "./panels";
import type { SectionProps } from "./types";

export function BehaviourSection(props: SectionProps) {
  const t = useT();
  const view = useSectionView(props, "behaviour");
  if (view.isLoading) return <SectionSkeleton />;
  if (view.error) return <SectionError error={view.error} />;
  const data = view.data;
  const devices = kn(rowsOf(data, "devices"));

  return (
    <>
      <Group title={t("monitor.analytics.panels.group.acquisition")}>
        <div className="grid gap-4 md:grid-cols-2">
          <RankedList
            title={t("monitor.analytics.panels.channels")}
            rows={kn(rowsOf(data, "channels"))}
            dim="channel"
          />
          <RankedList
            title={t("monitor.analytics.panels.sources")}
            rows={kn(rowsOf(data, "sources"))}
            dim="source"
          />
          <RankedList
            title={t("monitor.analytics.panels.campaigns")}
            rows={kn(rowsOf(data, "campaigns"))}
            dim="utmSource"
            filterValue={(k) => k.split(" · ")[0] ?? k}
          />
          <RankedList
            title={t("monitor.analytics.panels.campaignNames")}
            rows={rowsOf(data, "campaignNames").map((r) => ({
              k: str(r.k),
              n: n0(r.n),
              converters: n0(r.converters),
            }))}
            dim="utmCampaign"
            extra={(r) =>
              "converters" in r
                ? t("monitor.analytics.panels.convertersShort", {
                    n: fmtInt(r.converters),
                  })
                : null
            }
          />
        </div>
        <Attribution rows={rowsOf(data, "attribution")} />
        <ChannelPerformance
          rows={rowsOf(data, "channelConversion")}
          money={moneyOf(data)}
        />
      </Group>

      <Group title={t("monitor.analytics.panels.group.pages")}>
        <div className="grid gap-4 lg:grid-cols-3">
          <RankedList
            title={t("monitor.analytics.panels.pages")}
            rows={kn(rowsOf(data, "pages"))}
            dim="path"
          />
          <RankedList
            title={t("monitor.analytics.panels.entryPages")}
            rows={kn(rowsOf(data, "entryPages"))}
            dim="path"
          />
          <RankedList
            title={t("monitor.analytics.panels.exitPages")}
            rows={kn(rowsOf(data, "exitPages"))}
            dim="path"
          />
        </div>
      </Group>

      {rowsOf(data, "products").length > 0 && (
        <Group title={t("monitor.analytics.panels.group.products")}>
          <ProductFunnel rows={rowsOf(data, "products")} />
        </Group>
      )}

      <Group title={t("monitor.analytics.panels.group.audience")}>
        <div className="grid gap-4 lg:grid-cols-3">
          <RankedList
            title={t("monitor.analytics.panels.countries")}
            rows={kn(rowsOf(data, "countries"))}
            dim="country"
            label={countryLabel}
          />
          <RankedList
            title={t("monitor.analytics.panels.regions")}
            rows={kn(rowsOf(data, "regions"))}
            dim="region"
          />
          <RankedList
            title={t("monitor.analytics.panels.cities")}
            rows={kn(rowsOf(data, "cities"))}
            dim="city"
          />
          <RankedList
            title={t("monitor.analytics.panels.devices")}
            rows={splitRows(devices, "first")}
            dim="device"
            label={capitalize}
          />
          <RankedList
            title={t("monitor.analytics.panels.browsers")}
            rows={splitRows(devices, "second")}
            dim="browser"
          />
          <RankedList
            title={t("monitor.analytics.panels.os")}
            rows={kn(rowsOf(data, "os"))}
            dim="os"
          />
        </div>
      </Group>
    </>
  );
}

/**
 * Credit for the same conversions assigned to the first and to the last
 * channel. Where they disagree, one of the two reports overpays a channel.
 */
function Attribution({ rows }: { rows: Row[] }) {
  const t = useT();
  if (rows.length === 0) return null;
  const max = Math.max(
    1,
    ...rows.map((r) => Math.max(n0(r.first_touch), n0(r.last_touch))),
  );
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.col.channel"),
      cell: (r) => <FilterKey>{str(r.k)}</FilterKey>,
    },
    {
      id: "first",
      header: (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-chart-4" />
          {t("monitor.analytics.panels.col.firstTouch")}
        </span>
      ),
      numeric: true,
      cell: (r) => fmtInt(r.first_touch),
    },
    {
      id: "last",
      header: (
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-chart-1" />
          {t("monitor.analytics.panels.col.lastTouch")}
        </span>
      ),
      numeric: true,
      cell: (r) => fmtInt(r.last_touch),
    },
    {
      id: "shift",
      header: t("monitor.analytics.panels.col.shift"),
      numeric: true,
      cell: (r) => {
        const d = n0(r.last_touch) - n0(r.first_touch);
        if (d === 0) return <span className="text-muted-foreground">—</span>;
        return (
          <span className={cn(d > 0 ? "text-success" : "text-destructive")}>
            {d > 0 ? "+" : "−"}
            {fmtInt(Math.abs(d))}
          </span>
        );
      },
    },
    {
      id: "bar",
      header: "",
      className: "w-[34%]",
      cell: (r) => (
        <div className="flex flex-col gap-1">
          <div
            className="h-1.5 rounded-full bg-chart-4"
            style={{ width: `${(100 * n0(r.first_touch)) / max}%` }}
          />
          <div
            className="h-1.5 rounded-full bg-chart-1"
            style={{ width: `${(100 * n0(r.last_touch)) / max}%` }}
          />
        </div>
      ),
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.attribution")}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => str(r.k)}
        filter={(r) => ({ d: "channel", v: str(r.k) })}
      />
    </Panel>
  );
}

function ChannelPerformance({
  rows,
  money,
}: {
  rows: Row[];
  money: { currency: string | null; hasRevenue: boolean };
}) {
  const t = useT();
  if (rows.length === 0) return null;
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.col.channel"),
      cell: (r) => <FilterKey>{str(r.k)}</FilterKey>,
    },
    {
      id: "visitors",
      header: t("monitor.analytics.panels.col.visitors"),
      numeric: true,
      cell: (r) => fmtInt(r.visitors),
    },
    {
      id: "converters",
      header: t("monitor.analytics.panels.col.converters"),
      numeric: true,
      cell: (r) => fmtInt(r.converters),
    },
    {
      id: "cr",
      header: t("monitor.analytics.panels.col.conversion"),
      numeric: true,
      cell: (r) => fmtPct(num(r.cr), 2),
    },
    {
      id: "revenue",
      header: money.currency
        ? t("monitor.analytics.panels.col.revenueIn", {
            currency: money.currency,
          })
        : t("monitor.analytics.panels.col.revenue"),
      numeric: true,
      cell: (r) =>
        money.hasRevenue ? fmtMoney(r.revenue, money.currency) : "—",
    },
  ];
  return (
    <Panel title={t("monitor.analytics.panels.channelPerformance")}>
      <PanelTable
        columns={columns}
        rows={rows}
        rowKey={(r) => str(r.k)}
        filter={(r) => ({ d: "channel", v: str(r.k) })}
      />
    </Panel>
  );
}

/**
 * View → cart → purchase per item. Each rate is guarded by its own
 * denominator: more visitors at a later step means the item id is missing on
 * the earlier event, and the rate would be a fraction of the truth.
 */
function ProductFunnel({ rows }: { rows: Row[] }) {
  const t = useT();
  const okCart = (r: Row) => n0(r.carted) <= n0(r.viewed);
  const okBuy = (r: Row) => n0(r.bought) <= n0(r.carted);
  const broken = rows.filter((r) => !okCart(r) || !okBuy(r)).length;
  const rate = (v: unknown, ok: boolean, tip: string) =>
    ok ? (
      fmtPct(num(v), 1)
    ) : (
      <WithheldBadge label={t("monitor.analytics.panels.withheld")} tip={tip} />
    );
  const columns: Column<Row>[] = [
    {
      id: "k",
      header: t("monitor.analytics.panels.col.item"),
      className: "font-mono text-xs",
      cell: (r) => str(r.k),
    },
    {
      id: "viewed",
      header: t("monitor.analytics.panels.col.viewed"),
      numeric: true,
      cell: (r) => fmtInt(r.viewed),
    },
    {
      id: "carted",
      header: t("monitor.analytics.panels.col.carted"),
      numeric: true,
      cell: (r) => fmtInt(r.carted),
    },
    {
      id: "bought",
      header: t("monitor.analytics.panels.col.bought"),
      numeric: true,
      cell: (r) => fmtInt(r.bought),
    },
    {
      id: "orders",
      header: t("monitor.analytics.panels.col.orders"),
      numeric: true,
      cell: (r) => fmtInt(r.orders),
    },
    {
      id: "toCart",
      header: t("monitor.analytics.panels.col.viewToCart"),
      numeric: true,
      cell: (r) =>
        rate(
          r.to_cart,
          okCart(r),
          t("monitor.analytics.panels.products.noViewTip"),
        ),
    },
    {
      id: "toBuy",
      header: t("monitor.analytics.panels.col.cartToBuy"),
      numeric: true,
      cell: (r) =>
        rate(
          r.to_buy,
          okBuy(r),
          t("monitor.analytics.panels.products.noCartTip"),
        ),
    },
  ];
  return (
    <Panel
      title={t("monitor.analytics.panels.productFunnel")}
      aside={
        broken > 0 && (
          <WithheldBadge
            label={t("monitor.analytics.panels.products.withheldCount", {
              n: broken,
            })}
            tip={t("monitor.analytics.panels.products.withheldTip")}
          />
        )
      }
    >
      <PanelTable columns={columns} rows={rows} rowKey={(r) => str(r.k)} />
    </Panel>
  );
}
