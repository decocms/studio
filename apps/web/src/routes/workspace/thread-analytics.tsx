/**
 * `/thread-analytics` — every chat, automation and task run, for admin orgs:
 * a live feed pushed over `/watch?scope=all`, usage and spend, and errors.
 *
 * Server-gated: every tool behind it refuses outside an admin org.
 */

import { ChatLayout } from "@/components/chat-layout";
import {
  SectionView,
  threadHref,
} from "@/layouts/task-board/analytics-sections";
import {
  useLiveThreads,
  useThreadAnalyticsOrgs,
  useThreadAnalyticsSections,
  type LiveThread,
  type LiveThreadsInput,
} from "@/hooks/use-thread-analytics";
import { useT } from "@/i18n/use-t";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@decocms/ui/components/table.tsx";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@decocms/ui/components/tabs.tsx";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

const RANGE_DAYS = [1, 7, 30, 90] as const;
const STATUSES = [
  "in_progress",
  "requires_action",
  "failed",
  "completed",
] as const;
const KINDS = ["chat", "automation", "task"] as const;
const ANY = "any";

type Tab = "live" | "usage" | "errors";

const STATUS_KEYS = {
  in_progress: "thread.analytics.statusRunning",
  requires_action: "thread.analytics.statusWaiting",
  failed: "thread.analytics.statusFailed",
  completed: "thread.analytics.statusCompleted",
} as const;

const KIND_KEYS = {
  chat: "thread.analytics.kindChat",
  automation: "thread.analytics.kindAutomation",
  task: "thread.analytics.kindTask",
} as const;

const STATUS_VARIANT = {
  in_progress: "default",
  requires_action: "warning",
  failed: "destructive",
  completed: "secondary",
} as const;

function Loading() {
  return (
    <div className="flex justify-center py-12">
      <Spinner className="size-5 text-muted-foreground" />
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-border p-8 text-center text-sm text-destructive">
      {message}
    </div>
  );
}

function Counter({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-medium text-foreground tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function LiveRow({ thread }: { thread: LiveThread }) {
  const t = useT();
  const status = thread.status as keyof typeof STATUS_KEYS;
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
        {new Date(thread.updatedAt).toLocaleString()}
      </TableCell>
      <TableCell className="text-sm">{thread.orgSlug}</TableCell>
      <TableCell className="max-w-sm text-sm">
        <a
          href={threadHref(thread.orgSlug, thread.id)}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-foreground underline-offset-2 hover:underline"
        >
          {thread.title || t("thread.analytics.untitled")}
        </a>
        {thread.status === "failed" &&
          (thread.lastError || thread.failureReason) && (
            <div className="truncate text-xs text-destructive">
              {thread.lastError ?? thread.failureReason}
            </div>
          )}
      </TableCell>
      <TableCell className="text-sm">{t(KIND_KEYS[thread.kind])}</TableCell>
      <TableCell>
        <Badge variant={STATUS_VARIANT[status] ?? "outline"}>
          {STATUS_KEYS[status] ? t(STATUS_KEYS[status]) : thread.status}
        </Badge>
      </TableCell>
      <TableCell className="max-w-48 truncate text-sm">
        {thread.userEmail ?? thread.userName ?? "—"}
      </TableCell>
      <TableCell className="max-w-48 truncate text-sm">
        {thread.agent}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        {thread.usd === null ? "—" : `$${thread.usd.toFixed(2)}`}
      </TableCell>
      <TableCell className="text-sm tabular-nums">
        {thread.tokens === null ? "—" : thread.tokens.toLocaleString()}
      </TableCell>
    </TableRow>
  );
}

function LivePanel({ org }: { org: string }) {
  const t = useT();
  const [status, setStatus] = useState<string>(ANY);
  const [kind, setKind] = useState<string>(ANY);
  const input: LiveThreadsInput = {
    org,
    status: status === ANY ? undefined : (status as (typeof STATUSES)[number]),
    kind: kind === ANY ? undefined : (kind as (typeof KINDS)[number]),
    limit: 150,
  };
  const { data, isLoading, error } = useLiveThreads(input, true);

  return (
    <div className="flex flex-col gap-6 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-[180px]" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>
              {t("thread.analytics.anyStatus")}
            </SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(STATUS_KEYS[s])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-[180px]" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>{t("thread.analytics.anyKind")}</SelectItem>
            {KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {t(KIND_KEYS[k])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-success" />
          {t("thread.analytics.liveHint")}
        </span>
      </div>

      {isLoading ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error.message} />
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Counter
              label={t("thread.analytics.countRunning")}
              value={data.counts.running}
            />
            <Counter
              label={t("thread.analytics.countWaiting")}
              value={data.counts.waiting}
            />
            <Counter
              label={t("thread.analytics.countFailedHour")}
              value={data.counts.failedLastHour}
            />
          </div>
          {data.threads.length === 0 ? (
            <div className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">
              {t("thread.analytics.empty")}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("thread.analytics.colUpdated")}</TableHead>
                    <TableHead>{t("thread.analytics.colOrg")}</TableHead>
                    <TableHead>{t("thread.analytics.colChat")}</TableHead>
                    <TableHead>{t("thread.analytics.colKind")}</TableHead>
                    <TableHead>{t("thread.analytics.colStatus")}</TableHead>
                    <TableHead>{t("thread.analytics.colUser")}</TableHead>
                    <TableHead>{t("thread.analytics.colAgent")}</TableHead>
                    <TableHead>{t("thread.analytics.colCost")}</TableHead>
                    <TableHead>{t("thread.analytics.colTokens")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.threads.map((thread) => (
                    <LiveRow key={thread.id} thread={thread} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

function SectionsPanel({
  tool,
  org,
  from,
  to,
}: {
  tool: "THREAD_ANALYTICS_USAGE" | "THREAD_ANALYTICS_ERRORS";
  org: string;
  from: string;
  to: string;
}) {
  const t = useT();
  const { data, isLoading, error } = useThreadAnalyticsSections(tool, {
    org,
    from,
    to,
  });
  if (isLoading) return <Loading />;
  if (error) return <ErrorBox message={error.message} />;
  if (!data) return null;
  return (
    <div className="flex flex-col gap-8 py-6">
      {data.sections.map((section) => (
        <SectionView key={section.title} section={section} threadLinks />
      ))}
      <p className="text-xs text-muted-foreground">
        {t("thread.analytics.costFootnote")}
      </p>
    </div>
  );
}

export default function ThreadAnalyticsRoute() {
  const t = useT();
  const orgSlug = useParams({ strict: false }).org ?? "";
  const admin = useThreadAnalyticsOrgs();
  const [org, setOrg] = useState<string>("all");
  const [days, setDays] = useState<number>(7);
  const [tab, setTab] = useState<Tab>("live");
  // Frozen at mount so the query key only moves when `days` does.
  const [mountedAt] = useState(() => Date.now());
  const to = new Date(mountedAt).toISOString();
  const from = new Date(mountedAt - days * 86400_000).toISOString();

  if (admin.isLoading) {
    return (
      <ChatLayout.Content>
        <Loading />
      </ChatLayout.Content>
    );
  }
  if (!admin.data?.isAdmin) {
    return (
      <ChatLayout.Content>
        <div className="p-8 text-center text-sm text-muted-foreground">
          {t("thread.analytics.notAdmin")}
        </div>
      </ChatLayout.Content>
    );
  }

  const orgOptions = [
    { value: "all", label: t("taskBoard.analytics.orgAll") },
    { value: orgSlug, label: t("taskBoard.analytics.orgCurrent") },
    ...admin.data.orgs
      .filter((o) => o.slug !== orgSlug)
      .map((o) => ({ value: o.slug, label: `${o.slug} · ${o.name}` })),
  ];

  return (
    <ChatLayout.Content>
      <div className="flex h-full min-h-0 flex-col overflow-auto">
        <div className="mx-auto flex w-full max-w-[1680px] flex-col gap-4 px-4 py-6 sm:px-8 sm:py-8">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-medium text-foreground">
              {t("thread.analytics.title")}
            </h1>
            <div className="ml-auto flex items-center gap-2">
              <Combobox
                options={orgOptions}
                value={org}
                onChange={setOrg}
                width="w-[240px]"
                searchPlaceholder={t("taskBoard.analytics.orgSearch")}
                emptyMessage={t("taskBoard.analytics.orgEmpty")}
              />
              {tab !== "live" && (
                <Select
                  value={String(days)}
                  onValueChange={(v) => setDays(Number(v))}
                >
                  <SelectTrigger className="w-[140px]" size="sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {RANGE_DAYS.map((d) => (
                      <SelectItem key={d} value={String(d)}>
                        {t("taskBoard.analytics.rangeDays", {
                          days: String(d),
                        })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          {org !== orgSlug && (
            <div className="rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
              {org === "all"
                ? t("taskBoard.analytics.bannerAll")
                : t("taskBoard.analytics.bannerOrg", { org })}
            </div>
          )}

          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTrigger value="live">
                {t("thread.analytics.tabLive")}
              </TabsTrigger>
              <TabsTrigger value="usage">
                {t("thread.analytics.tabUsage")}
              </TabsTrigger>
              <TabsTrigger value="errors">
                {t("thread.analytics.tabErrors")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="live">
              {tab === "live" && <LivePanel org={org} />}
            </TabsContent>
            <TabsContent value="usage">
              {tab === "usage" && (
                <SectionsPanel
                  tool="THREAD_ANALYTICS_USAGE"
                  org={org}
                  from={from}
                  to={to}
                />
              )}
            </TabsContent>
            <TabsContent value="errors">
              {tab === "errors" && (
                <SectionsPanel
                  tool="THREAD_ANALYTICS_ERRORS"
                  org={org}
                  from={from}
                  to={to}
                />
              )}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </ChatLayout.Content>
  );
}
