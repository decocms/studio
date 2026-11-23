/**
 * The Monitor's Alerts tab: the open alerts, the thresholds each rule alerts
 * at, and the alerts already acked, with who acked them and the task opened
 * for them.
 */

import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, CheckCircle } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@decocms/ui/components/input.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { taskKey } from "@decocms/shared/task-key";
import { ruleLabel } from "@/components/order-monitor/order-monitor-day";
import {
  type Alert,
  type AlertRule,
  useAckedAlerts,
  useAlertRules,
  useAlerts,
} from "@/hooks/use-alerts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import { formatTimeAgo } from "@/lib/format-time";

const ROW = "flex items-center gap-4 px-5 py-4";
/** A list that scrolls inside the page instead of growing it. */
const LIST =
  "surface max-h-[26rem] divide-y divide-border/70 overflow-y-auto overscroll-contain";

function Section({
  title,
  count,
  hint,
  children,
}: {
  title: string;
  count?: number;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 className="text-sm font-medium text-foreground">
          {title}
          {count ? (
            <span className="ml-1.5 text-muted-foreground tabular-nums">
              {count}
            </span>
          ) : null}
        </h2>
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

/** Rules whose threshold is a share of expected; the rest are multiples of it. */
const isDrop = (rule: AlertRule["rule"]) =>
  rule === "orders_drop" ||
  rule === "visitors_drop" ||
  rule === "pageviews_drop";

function ruleMeta(rule: AlertRule["rule"], t: TFunction) {
  switch (rule) {
    case "orders_drop":
      return {
        label: ruleLabel(rule, t),
        help: t("monitor.alerts.rules.dropHelp"),
        unit: t("monitor.alerts.rules.unitOrders"),
      };
    case "denied_spike":
      return {
        label: ruleLabel(rule, t),
        help: t("monitor.alerts.rules.spikeHelp"),
        unit: t("monitor.alerts.rules.unitDenials"),
      };
    case "cancel_spike":
      return {
        label: ruleLabel(rule, t),
        help: t("monitor.alerts.rules.spikeHelp"),
        unit: t("monitor.alerts.rules.unitCancellations"),
      };
    case "visitors_drop":
      return {
        label: t("monitor.alerts.rules.visitors"),
        help: t("monitor.alerts.rules.visitorsHelp"),
        unit: t("monitor.alerts.rules.unitVisitors"),
      };
    case "pageviews_drop":
      return {
        label: t("monitor.alerts.rules.pageviews"),
        help: t("monitor.alerts.rules.pageviewsHelp"),
        unit: t("monitor.alerts.rules.unitPageviews"),
      };
    default: {
      const unhandled: never = rule;
      return unhandled;
    }
  }
}

type Draft = Record<
  AlertRule["rule"],
  { threshold: string; minVolume: string }
>;

const draftOf = (rules: AlertRule[]) =>
  Object.fromEntries(
    rules.map((r) => [
      r.rule,
      { threshold: String(r.threshold), minVolume: String(r.minVolume) },
    ]),
  ) as Draft;

/** A draft value as the tool takes it, or null when it isn't one. */
function parsed(rule: AlertRule, d: Draft[AlertRule["rule"]]) {
  const threshold = Number(d.threshold);
  const minVolume = Number(d.minVolume);
  const ok =
    d.threshold !== "" &&
    d.minVolume !== "" &&
    Number.isFinite(threshold) &&
    Number.isFinite(minVolume) &&
    minVolume >= 0 &&
    (isDrop(rule.rule) ? threshold >= 1 && threshold <= 99 : threshold > 1);
  return ok ? { threshold, minVolume } : null;
}

function RulesForm({
  rules,
  saving,
  onSave,
}: {
  rules: AlertRule[];
  saving: boolean;
  onSave: (
    changes: {
      rule: AlertRule["rule"];
      threshold: number;
      minVolume: number;
    }[],
  ) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(() => draftOf(rules));
  const rows = rules.map((rule) => {
    const d = draft[rule.rule];
    const next = parsed(rule, d);
    return {
      rule,
      d,
      next,
      dirty:
        !next ||
        next.threshold !== rule.threshold ||
        next.minVolume !== rule.minVolume,
    };
  });
  const valid = rows.every((r) => r.next);
  const changes = rows.flatMap((r) =>
    r.dirty && r.next ? [{ rule: r.rule.rule, ...r.next }] : [],
  );
  const atDefaults = rules.every(
    (r) =>
      r.threshold === r.defaults.threshold &&
      r.minVolume === r.defaults.minVolume,
  );
  const set = (
    rule: AlertRule["rule"],
    field: "threshold" | "minVolume",
    value: string,
  ) => setDraft({ ...draft, [rule]: { ...draft[rule], [field]: value } });
  const field = (
    rule: AlertRule,
    key: "threshold" | "minVolume",
    unit: string,
    invalid: boolean,
  ) => {
    const input = (
      <InputGroupInput
        type="number"
        inputMode="decimal"
        min={0}
        aria-invalid={invalid}
        aria-label={`${ruleMeta(rule.rule, t).label}: ${unit}`}
        value={draft[rule.rule][key]}
        onChange={(e) => set(rule.rule, key, e.target.value)}
        className="tabular-nums"
      />
    );
    return key === "threshold" ? (
      <InputGroup size="sm" className="w-full">
        {input}
        <InputGroupAddon className="text-xs">{unit}</InputGroupAddon>
      </InputGroup>
    ) : (
      <span className="flex items-center gap-2">
        <InputGroup size="sm" className="w-20 shrink-0">
          {input}
        </InputGroup>
        <span className="truncate text-sm text-muted-foreground">{unit}</span>
      </span>
    );
  };

  return (
    <div className="surface overflow-hidden">
      <div className="grid grid-cols-[minmax(0,1fr)_7rem_13rem] items-center gap-x-4 gap-y-0">
        <span className="text-meta px-5 pt-3 pb-2">
          {t("monitor.alerts.rules.colRule")}
        </span>
        <span className="text-meta pt-3 pb-2">
          {t("monitor.alerts.rules.colThreshold")}
        </span>
        <span className="text-meta pt-3 pr-5 pb-2">
          {t("monitor.alerts.rules.colMinimum")}
        </span>
        {rows.map(({ rule, d }) => {
          const meta = ruleMeta(rule.rule, t);
          const drop = isDrop(rule.rule);
          const bad = parsed(rule, d) === null;
          return (
            <div key={rule.rule} className="contents">
              <span className="flex min-w-0 flex-col gap-0.5 border-t border-border/70 px-5 py-3">
                <span className="text-sm font-medium text-foreground">
                  {meta.label}
                </span>
                <span className="text-meta">{meta.help}</span>
              </span>
              <span className="flex h-full items-center border-t border-border/70 py-3">
                {field(rule, "threshold", drop ? "%" : "×", bad)}
              </span>
              <span className="flex h-full items-center border-t border-border/70 py-3 pr-5">
                {field(
                  rule,
                  "minVolume",
                  meta.unit,
                  d.minVolume === "" || Number(d.minVolume) < 0,
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border/70 px-5 py-3">
        <span className="text-meta mr-auto">
          {t("monitor.alerts.rules.note")}
        </span>
        {!atDefaults && (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={() =>
              onSave(rules.map((r) => ({ rule: r.rule, ...r.defaults })))
            }
          >
            {t("monitor.alerts.rules.reset")}
          </Button>
        )}
        <Button
          size="sm"
          disabled={changes.length === 0 || !valid || saving}
          onClick={() => onSave(changes)}
        >
          {t("monitor.alerts.rules.save")}
        </Button>
      </div>
    </div>
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
  const openQuery = useAlerts(orgSlug);
  const ackedQuery = useAckedAlerts(orgSlug);
  const rules = useAlertRules(orgSlug);
  const inScope = (alerts: Alert[]) =>
    scoped ? alerts.filter((a) => stores.has(a.subjectId)) : alerts;
  const open = inScope(openQuery.alerts);
  const acked = inScope(ackedQuery.alerts);
  const openStore = (a: Alert) =>
    stores.has(a.subjectId) ? () => onOpenStore(a.subjectId) : null;

  return (
    <div className="mx-auto flex w-full max-w-[1200px] flex-col gap-8 px-4 pt-6 pb-10 md:px-10">
      <Section title={t("monitor.alerts.open")} count={open.length}>
        {openQuery.loading ? (
          <Skeleton className="h-24" />
        ) : open.length === 0 ? (
          <Empty>{t("monitor.alerts.openEmpty")}</Empty>
        ) : (
          <ul className={LIST}>
            {open.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                orgSlug={orgSlug}
                onOpenStore={openStore(a)}
                onAck={() => openQuery.ack(a.id)}
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
          <RulesForm
            // Saved values reset the draft.
            key={rules.rules
              .map((r) => `${r.rule}:${r.threshold}:${r.minVolume}`)
              .join("|")}
            rules={rules.rules}
            saving={rules.saving}
            onSave={(changes) =>
              void Promise.all(changes.map((c) => rules.save(c)))
            }
          />
        )}
      </Section>

      <Section title={t("monitor.alerts.ackedTitle")}>
        {ackedQuery.loading ? (
          <Skeleton className="h-24" />
        ) : acked.length === 0 && !ackedQuery.hasMore ? (
          <Empty>{t("monitor.alerts.ackedEmpty")}</Empty>
        ) : (
          <ul className={LIST}>
            {acked.map((a) => (
              <AlertRow
                key={a.id}
                alert={a}
                orgSlug={orgSlug}
                onOpenStore={openStore(a)}
                onAck={null}
              />
            ))}
            {ackedQuery.hasMore && (
              <li>
                <button
                  type="button"
                  disabled={ackedQuery.loadingMore}
                  onClick={ackedQuery.loadMore}
                  className="focus-ring w-full px-5 py-3 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/30 hover:text-foreground disabled:opacity-60"
                >
                  {t("monitor.alerts.loadMore")}
                </button>
              </li>
            )}
          </ul>
        )}
      </Section>
    </div>
  );
}
