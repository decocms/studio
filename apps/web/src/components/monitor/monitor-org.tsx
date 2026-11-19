/**
 * Another org the Monitor looks into: `all` or one org's slug, from an admin
 * org only (`?customer=`). The order-monitor reads pass it as `?org=`; the
 * API refuses it to anyone else.
 */

import { Combobox } from "@decocms/ui/components/combobox.tsx";
import { useOrderMonitorAdminOrgs } from "@/hooks/use-order-monitor";
import { useT } from "@/i18n/use-t.ts";

const OWN = "";

export function MonitorOrgPicker({
  orgSlug,
  value,
  onChange,
}: {
  orgSlug: string;
  value: string | undefined;
  onChange: (customer: string | undefined) => void;
}) {
  const t = useT();
  const { data } = useOrderMonitorAdminOrgs(orgSlug);
  if (!data?.isAdmin) return null;
  const options = [
    { value: OWN, label: t("monitor.customer.own") },
    { value: "all", label: t("monitor.customer.all") },
    ...data.orgs
      .filter((o) => o.slug !== orgSlug)
      .map((o) => ({ value: o.slug, label: o.name || o.slug })),
  ];
  return (
    <Combobox
      options={options}
      value={value ?? OWN}
      onChange={(next) => onChange(next === OWN ? undefined : next)}
      width="w-[220px]"
      placeholder={t("monitor.customer.placeholder")}
      searchPlaceholder={t("monitor.customer.search")}
      emptyMessage={t("monitor.customer.empty")}
    />
  );
}
