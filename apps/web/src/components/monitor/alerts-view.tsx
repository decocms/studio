/**
 * The Monitor's Alerts tab: the open alerts, the thresholds each rule alerts
 * at, and the alerts already acked, with who acked them and the task opened
 * for them.
 */

import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { taskKey } from "@decocms/shared/task-key";
import { ruleLabel } from "@/components/order-monitor/order-monitor-day";
import {
  type Alert,
  type AlertRule,
  useAlertRules,
  useAlerts,
} from "@/hooks/use-alerts";
import { useT } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time";

const ROW = "flex items-center gap-4 px-5 py-4";

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {hint && <p className="text-meta">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="surface px-5 py-4 text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function AlertRow({
  alert,
  orgSlug,
  onOpenStore,
  onAck,
}: {
  alert: Alert;
  orgSlug: string;
  /** Null when the alert's subject isn't one of the stores in scope. */
  onOpenStore: (() => void) | null;
  onAck: (() => void) | null;
}) {
  const t = useT();
  const acked = alert.ackedAt !== null;
  const key =
    alert.taskKeySeq === null ? null : taskKey(orgSlug, alert.taskKeySeq);
  const meta = acked
    ? [
        alert.ackedByName
          ? t("monitor.alerts.ackedBy", {
              ago: formatTimeAgo(new Date(alert.ackedAt!)),
              name: alert.ackedByName,
            })
          : t("monitor.alerts.acked", {
              ago: formatTimeAgo(new Date(alert.ackedAt!)),
            }),
        alert.ackNote,
      ]
    : [
        t("monitor.alerts.opened", {
          ago: formatTimeAgo(new Date(alert.createdAt)),
        }),
        alert.body,
      ];
  const title = (
    <span className="truncate text-sm font-medium text-foreground">
      {alert.title}
    </span>
  );
  return (
    <li className={ROW}>
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-full",
          acked
            ? "bg-muted text-muted-foreground"
            : "bg-destructive/10 text-destructive",
        )}
      >
        {acked ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {onOpenStore ? (
          <button
            type="button"
            onClick={onOpenStore}
            className="focus-ring min-w-0 truncate text-left hover:underline"
          >
            {title}
          </button>
        ) : (
          title
        )}
        <span className="text-meta truncate">
          {meta.filter(Boolean).join(" · ")}
        </span>
      </span>
      {key && (
        <Link
          to="/$org/t/$taskKey"
          params={{ org: orgSlug, taskKey: key }}
          className="shrink-0 text-xs font-medium text-foreground underline-offset-2 hover:underline"
        >
          {key}
        </Link>
      )}
      {onAck && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onAck}
        >
          {t("monitor.signal.ack")}
        </Button>
      )}
    </li>
  );
}

function RuleRow({
  rule,
  saving,
  onSave,
}: {
  rule: AlertRule;
  saving: boolean;
  onSave: (next: { threshold: number; minVolume: number }) => void;
}) {
  const t = useT();
  const [threshold, setThreshold] = useState(String(rule.threshold));
  const [minVolume, setMinVolume] = useState(String(rule.minVolume));
  const drop = rule.rule === "orders_drop";
  const next = { threshold: Number(threshold), minVolume: Number(minVolume) };
  const valid =
    threshold !== "" &&
    minVolume !== "" &&
    Number.isFinite(next.threshold) &&
    Number.isFinite(next.minVolume) &&
    next.minVolume >= 0 &&
    (drop ? next.threshold >= 1 && next.threshold <= 99 : next.threshold > 1);
  const dirty =
    next.threshold !== rule.threshold || next.minVolume !== rule.minVolume;
  const isDefault =
    rule.threshold === rule.defaults.threshold &&
    rule.minVolume === rule.defaults.minVolume;
  const number = (value: string, onChange: (v: string) => void) => (
    <Input
      type="number"
      inputMode="decimal"
      min={0}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 w-20 tabular-nums"
    />
  );
  return (
    <li className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:gap-6">
      <span className="w-40 shrink-0 text-sm font-medium text-foreground">
        {ruleLabel(rule.rule, t)}
      </span>
      <span className="flex flex-1 flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {drop
          ? t("monitor.alerts.rules.dropWhen")
          : t("monitor.alerts.rules.spikeWhen")}
        {number(threshold, setThreshold)}
        {drop
          ? t("monitor.alerts.rules.dropUnit")
          : t("monitor.alerts.rules.spikeUnit")}
        <span className="basis-full md:basis-auto" />
        {drop
          ? t("monitor.alerts.rules.dropMin")
          : t("monitor.alerts.rules.spikeMin")}
        {number(minVolume, setMinVolume)}
        {drop
          ? t("monitor.alerts.rules.dropMinUnit")
          : t("monitor.alerts.rules.spikeMinUnit")}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {!isDefault && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() => onSave(rule.defaults)}
          >
            {t("monitor.alerts.rules.reset")}
          </Button>
        )}
        <Button
          size="sm"
          disabled={!dirty || !valid || saving}
          onClick={() => onSave(next)}
        >
          {t("monitor.alerts.rules.save")}
        </Button>
      </span>
    </li>
  );
}

export function AlertsView({
  orgSlug,
  stores,
  scoped,
  onOpenStore,
}: {
  orgSlug: string;
  /** The monitored stores in scope, by connection id. */
  stores: ReadonlySet<string>;
  /** A project's tab: alerts about stores outside it are left out. */
  scoped: boolean;
  onOpenStore: (connectionId: string) => void;
}) {
  const t = useT();
  const { ack } = useAlerts(orgSlug);
  const all = useAlerts(orgSlug, { includeAcked: true });
  const rules = useAlertRules(orgSlug);
  const inScope = scoped
    ? all.alerts.filter((a) => stores.has(a.subjectId))
    : all.alerts;
  const open = inScope.filter((a) => a.ackedAt === null);
  const acked = inScope.filter((a) => a.ackedAt !== null);
  const openStore = (a: Alert) =>
    stores.has(a.subjectId) ? () => onOpenStore(a.subjectId) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-4 pt-6 pb-10 md:px-10">
      <Section title={t("monitor.alerts.open")}>
        {all.loading ? (
          <Skeleton className="h-24" />
        ) : open.length === 0 ? (
          <Empty>{t("monitor.alerts.openEmpty")}</Empty>
        ) : (
          <ul className="surface divide-y divide-border/70 overflow-hidden">
            {open.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                orgSlug={orgSlug}
                onOpenStore={openStore(a)}
                onAck={() => ack(a.id)}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t("monitor.alerts.rules.title")}
        hint={t("monitor.alerts.rules.hint")}
      >
        {rules.loading ? (
          <Skeleton className="h-40" />
        ) : (
          <ul className="surface divide-y divide-border/70 overflow-hidden">
            {rules.rules.map((r) => (
              <RuleRow
                // Saved values reset the row's draft.
                key={`${r.rule}:${r.threshold}:${r.minVolume}`}
                rule={r}
                saving={rules.saving}
                onSave={(next) => void rules.save({ rule: r.rule, ...next })}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title={t("monitor.alerts.ackedTitle")}>
        {all.loading ? (
          <Skeleton className="h-24" />
        ) : acked.length === 0 ? (
          <Empty>{t("monitor.alerts.ackedEmpty")}</Empty>
        ) : (
          <ul className="surface divide-y divide-border/70 overflow-hidden">
            {acked.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                orgSlug={orgSlug}
                onOpenStore={openStore(a)}
                onAck={null}
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
