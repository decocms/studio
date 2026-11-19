/** Get the org's sales report by email at the hours you pick, store time. */

import { Mail01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@decocms/ui/components/toggle-group.tsx";
import { useSalesReportSubscription } from "@/hooks/use-order-monitor";
import { useT } from "@/i18n/use-t.ts";

const DEFAULT_HOURS = [9, 12, 18];
const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourList = (hours: readonly number[]) =>
  hours.map((h) => `${h}h`).join(" · ");

export function ReportSubscription({ orgSlug }: { orgSlug: string }) {
  const t = useT();
  const { hours, setHours } = useSalesReportSubscription(orgSlug);
  if (hours === undefined) return null;
  const set = (next: number[]) =>
    setHours.mutate([...next].sort((a, b) => a - b));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="tnum">
          <Mail01 />
          {hours.length > 0
            ? t("monitor.sales.emailAt", { hours: hourList(hours) })
            : t("monitor.sales.emailMe")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-72 flex-col gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">
            {t("monitor.sales.emailTitle")}
          </span>
          <span className="text-meta">{t("monitor.sales.emailHelp")}</span>
        </div>
        <ToggleGroup
          type="multiple"
          size="sm"
          className="grid grid-cols-6 gap-1"
          value={hours.map(String)}
          onValueChange={(v) => set(v.map(Number))}
          disabled={setHours.isPending}
        >
          {HOURS.map((h) => (
            <ToggleGroupItem
              key={h}
              value={String(h)}
              className="tnum"
              aria-label={`${h}h`}
            >
              {h}h
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {hours.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            className="self-end"
            onClick={() => set([])}
            disabled={setHours.isPending}
          >
            {t("monitor.sales.emailStop")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="self-end"
            onClick={() => set(DEFAULT_HOURS)}
            disabled={setHours.isPending}
          >
            {t("monitor.sales.emailDefault", {
              hours: hourList(DEFAULT_HOURS),
            })}
          </Button>
        )}
        {setHours.isError && (
          <span className="text-meta text-destructive">
            {t("monitor.sales.emailFailed")}
          </span>
        )}
      </PopoverContent>
    </Popover>
  );
}
