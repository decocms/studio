import { useState, type KeyboardEvent } from "react";
import { FilterLines, X } from "@untitledui/icons";
import { z } from "zod";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@decocms/ui/components/command.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { TopbarSelect } from "../topbar-select";
import {
  FILTER_DIMS,
  FILTER_OPS,
  encodeFilter,
  useAnalyticsSegment,
  useDecoView,
  useFilterValues,
  type AnalyticsFilter,
  type FilterDim,
  type FilterOp,
} from "./segment";
import type { SectionProps } from "./types";

function dimLabel(dim: FilterDim, t: TFunction): string {
  switch (dim) {
    case "path":
      return t("monitor.analytics.filters.dim.path");
    case "source":
      return t("monitor.analytics.filters.dim.source");
    case "channel":
      return t("monitor.analytics.filters.dim.channel");
    case "utmSource":
      return t("monitor.analytics.filters.dim.utmSource");
    case "utmMedium":
      return t("monitor.analytics.filters.dim.utmMedium");
    case "utmCampaign":
      return t("monitor.analytics.filters.dim.utmCampaign");
    case "country":
      return t("monitor.analytics.filters.dim.country");
    case "region":
      return t("monitor.analytics.filters.dim.region");
    case "city":
      return t("monitor.analytics.filters.dim.city");
    case "device":
      return t("monitor.analytics.filters.dim.device");
    case "browser":
      return t("monitor.analytics.filters.dim.browser");
    case "os":
      return t("monitor.analytics.filters.dim.os");
    case "name":
      return t("monitor.analytics.filters.dim.name");
    case "prop":
      return t("monitor.analytics.filters.dim.prop");
    case "exp":
      return t("monitor.analytics.filters.dim.exp");
    case "flag":
      return t("monitor.analytics.filters.dim.flag");
    default: {
      const unhandled: never = dim;
      return unhandled;
    }
  }
}

function opLabel(op: FilterOp, t: TFunction): string {
  switch (op) {
    case "is":
      return t("monitor.analytics.filters.op.is");
    case "not":
      return t("monitor.analytics.filters.op.not");
    case "has":
      return t("monitor.analytics.filters.op.has");
    case "starts":
      return t("monitor.analytics.filters.op.starts");
    default: {
      const unhandled: never = op;
      return unhandled;
    }
  }
}

/** "Country is BR", for a chip's accessible name. */
function filterLabel(f: AnalyticsFilter, t: TFunction): string {
  return `${dimLabel(f.d, t)} ${opLabel(f.op, t)} ${f.v}`;
}

/** What the read surface says about the segment, on every view's payload. */
const SegmentPayload = z.object({
  goals: z
    .array(z.object({ id: z.string(), name: z.string().optional() }))
    .catch([]),
  goal: z.string().nullish().catch(null),
  currencies: z
    .array(z.object({ k: z.string(), revenue: z.coerce.number().catch(0) }))
    .catch([]),
  currency: z.string().nullish().catch(null),
});

/** The builder: field → comparison → value, the value picked from what the
 *  field actually holds in the range or typed. */
function FilterBuilder({
  orgSlug,
  site,
  range,
  onApply,
}: {
  orgSlug: string;
  site: string;
  range: string;
  onApply: (f: AnalyticsFilter) => void;
}) {
  const t = useT();
  const [dim, setDim] = useState<FilterDim>("path");
  const [op, setOp] = useState<FilterOp>("is");
  const [value, setValue] = useState("");
  const suggestions = useFilterValues({ orgSlug, site, dim, range });
  const typed = value.trim();
  const apply = (v: string) => {
    if (v.trim()) onApply({ d: dim, op, v: v.trim() });
  };
  const values = suggestions.data ?? [];
  const offerTyped = typed !== "" && !values.some((s) => s.k === typed);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Select
          value={dim}
          onValueChange={(next) => {
            const found = FILTER_DIMS.find((d) => d === next);
            if (!found) return;
            setDim(found);
            setValue("");
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("monitor.analytics.filters.field")}
            className="flex-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_DIMS.map((d) => (
              <SelectItem key={d} value={d}>
                {dimLabel(d, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={op}
          onValueChange={(next) => {
            const found = FILTER_OPS.find((o) => o === next);
            if (found) setOp(found);
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("monitor.analytics.filters.operator")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPS.map((o) => (
              <SelectItem key={o} value={o}>
                {opLabel(o, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Command className="bg-transparent">
        <CommandInput
          size="sm"
          variant="boxed"
          aria-label={t("monitor.analytics.filters.value")}
          placeholder={t("monitor.analytics.filters.search")}
          value={value}
          onValueChange={setValue}
        />
        <CommandList className="mt-1 max-h-60">
          {!suggestions.isLoading && (
            <CommandEmpty className="text-meta px-2 py-3 text-center">
              {t("monitor.analytics.filters.noValues")}
            </CommandEmpty>
          )}
          {offerTyped && (
            <CommandItem value={typed} onSelect={() => apply(typed)}>
              <span className="truncate">
                {t("monitor.analytics.filters.use", { value: typed })}
              </span>
            </CommandItem>
          )}
          {values.map((s) => (
            <CommandItem key={s.k} value={s.k} onSelect={() => apply(s.k)}>
              <span className="min-w-0 flex-1 truncate">{s.k}</span>
              <span className="text-meta tnum">{s.n.toLocaleString()}</span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
      <Button size="sm" disabled={!typed} onClick={() => apply(typed)}>
        {t("monitor.analytics.filters.apply")}
      </Button>
    </div>
  );
}

/** Top-bar controls for the segment: goal, currency and the filter builder. */
export function SegmentActions({
  orgSlug,
  site,
  range,
  segment,
}: Omit<SectionProps, "status">) {
  const t = useT();
  const { setSegment, hasFilter, toggleFilter } = useAnalyticsSegment();
  const [open, setOpen] = useState(false);
  // The overview view shares its cache with the overview section.
  const view = useDecoView({ orgSlug, site, view: "overview", range, segment });
  const payload = SegmentPayload.safeParse(view.data?.data ?? {});
  const meta = payload.success
    ? payload.data
    : { goals: [], goal: null, currencies: [], currency: null };
  const defaultGoal = meta.goals[0]?.id;
  const goal = segment.goal ?? meta.goal ?? defaultGoal;
  const currencies = meta.currencies.filter(
    (c) => c.k !== "(none)" && c.revenue > 0,
  );
  const currency = segment.currency ?? meta.currency ?? currencies[0]?.k;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5 font-normal">
            <FilterLines size={14} className="text-muted-foreground" />
            {t("monitor.analytics.filters.add")}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-3">
          <FilterBuilder
            orgSlug={orgSlug}
            site={site}
            range={range}
            onApply={(f) => {
              if (!hasFilter(f)) toggleFilter(f);
              setOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
      {meta.goals.length > 1 && goal && (
        <TopbarSelect
          label={t("monitor.analytics.filters.goal")}
          value={goal}
          options={meta.goals.map((g) => ({
            value: g.id,
            // The read surface's built-in goal; a site's own goals carry their names.
            label:
              g.id === "purchase"
                ? t("monitor.analytics.filters.goalPurchase")
                : (g.name ?? g.id),
          }))}
          onChange={(next) =>
            setSegment({ goal: next === defaultGoal ? undefined : next })
          }
        />
      )}
      {currencies.length > 1 && currency && (
        <TopbarSelect
          label={t("monitor.analytics.filters.currency")}
          value={currency}
          options={currencies.map((c) => ({ value: c.k, label: c.k }))}
          onChange={(next) =>
            setSegment({
              currency: next === currencies[0]?.k ? undefined : next,
            })
          }
        />
      )}
    </>
  );
}

/** The filters in effect, removable one by one. */
export function SegmentChips() {
  const t = useT();
  const { segment, toggleFilter, clearFilters } = useAnalyticsSegment();
  if (segment.filters.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {segment.filters.map((f) => (
        <Badge key={encodeFilter(f)} size="segmented" className="text-sm">
          <span className="pl-2.5 text-muted-foreground">
            {dimLabel(f.d, t)}
          </span>
          <span className="px-1 text-muted-foreground">{opLabel(f.op, t)}</span>
          <span className="max-w-64 truncate pr-1 font-medium text-foreground">
            {f.v}
          </span>
          <button
            type="button"
            aria-label={t("monitor.analytics.filters.remove", {
              filter: filterLabel(f, t),
            })}
            onClick={() => toggleFilter(f)}
            className="focus-ring flex h-full items-center rounded-r-lg px-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X size={14} />
          </button>
        </Badge>
      ))}
      {segment.filters.length > 1 && (
        <Button
          variant="ghost"
          size="sm"
          className="font-normal text-muted-foreground"
          onClick={clearFilters}
        >
          {t("monitor.analytics.filters.clear")}
        </Button>
      )}
    </div>
  );
}

/**
 * Props that make a breakdown row a click-to-filter toggle on `d = value`:
 * spread onto the row element. `aria-pressed` marks the row already in the
 * segment, so a row can style itself with `aria-pressed:`.
 */
export function useRowFilter() {
  const { toggleFilter, hasFilter } = useAnalyticsSegment();
  return (d: FilterDim, v: string) => {
    const f: AnalyticsFilter = { d, op: "is", v };
    return {
      role: "button",
      tabIndex: 0,
      "aria-pressed": hasFilter(f),
      onClick: () => toggleFilter(f),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleFilter(f);
        }
      },
    };
  };
}
