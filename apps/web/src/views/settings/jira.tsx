/**
 * Settings → Tasks → "Jira integration" section — connect a Jira Cloud site
 * (email + API token), pick the board Studio watches, see the automations
 * each status starts, try one on an issue before switching it on, and wire the
 * webhook that tells it the moment an issue moves.
 */

import { type ReactNode, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { parseIssueKeys } from "@decocms/shared/jira/issue-key";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  ArrowUpRight,
  Check,
  ChevronSelectorVertical,
  Play,
  Plus,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import { MultiSelect } from "@decocms/ui/components/multi-select.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Page } from "@/components/page";
import { JiraIcon } from "@/components/icons/jira-icon";
import {
  AgentToolsSettings,
  ReviewSettings,
} from "@/components/settings/review-settings";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  boardLabels,
  boardSearchFilter,
  boardSearchText,
} from "./jira-board-labels";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en";
import {
  type JiraAutomation,
  type JiraIntegration,
  type JiraRuleFrom,
  useDeleteJiraIntegration,
  useJiraAutomations,
  useJiraBoardColumns,
  useJiraBoards,
  useCreateJiraAutomation,
  useJiraIntegration,
  useStartJiraRun,
  useUpsertJiraIntegration,
} from "@/hooks/use-jira-integration";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useAutomationActions, useAutomations } from "@/hooks/use-automations";
import { getDecopilotId, useProjectContext } from "@/sdk";
import { TaskSystemPromptSettings } from "./task-system-prompt";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

const CREATE_TOKEN_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

function SetupSteps({ stepKeys }: { stepKeys: TranslationKey[] }) {
  const t = useT();
  return (
    <ol className="list-decimal pl-5 flex flex-col gap-1 text-xs text-muted-foreground">
      {stepKeys.map((key) => (
        <li key={key}>{t(key)}</li>
      ))}
    </ol>
  );
}

function ConnectFormFields() {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const canConnect =
    siteUrl.trim() !== "" && email.trim() !== "" && apiToken.trim() !== "";

  return (
    <div className="flex flex-col gap-4 mt-3 max-w-md">
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.jira.siteLabel")}
        </label>
        <Input
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          placeholder={t("settings.jira.sitePlaceholder")}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-muted-foreground">
          {t("settings.jira.emailLabel")}
        </label>
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("settings.jira.emailPlaceholder")}
          autoComplete="off"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t("settings.jira.tokenLabel")}
          </label>
          <a
            href={CREATE_TOKEN_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-0.5 text-xs text-foreground hover:underline"
          >
            {t("settings.jira.createTokenLink")}
            <ArrowUpRight size={12} />
          </a>
        </div>
        <Input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={t("settings.jira.tokenPlaceholder")}
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">
          {t("settings.jira.tokenHint")}
        </p>
      </div>
      <Button
        size="sm"
        className="w-fit"
        disabled={!canConnect || upsert.isPending}
        onClick={() =>
          upsert.mutate(
            {
              siteUrl: siteUrl.trim(),
              email: email.trim(),
              apiToken: apiToken.trim(),
            },
            {
              onSuccess: () => toast.success(t("settings.jira.connected")),
              onError: (err) =>
                toast.error(
                  errorMessage(err, t("settings.jira.connectFailed")),
                ),
            },
          )
        }
      >
        {upsert.isPending
          ? t("settings.jira.connecting")
          : t("settings.jira.connect")}
      </Button>
    </div>
  );
}

function ConnectionRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const remove = useDeleteJiraIntegration();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <>
      <SettingsCardItem
        title={integration.siteUrl}
        description={integration.email}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmOpen(true)}
          >
            {t("settings.jira.disconnect")}
          </Button>
        }
      />
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.jira.disconnectTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.jira.disconnectDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.jira.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                remove.mutate(undefined, {
                  onSuccess: () =>
                    toast.success(t("settings.jira.disconnected")),
                  onError: (err) =>
                    toast.error(
                      errorMessage(err, t("settings.jira.saveFailed")),
                    ),
                })
              }
            >
              {t("settings.jira.disconnect")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BoardRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const boards = useJiraBoards(true);
  // Boards past the first 200 are only reachable by a name search.
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  const searched = useJiraBoards(query !== "", query);
  const listed = boards.data ?? [];
  const listedIds = new Set(listed.map((board) => board.id));
  const matches = query
    ? (searched.data ?? []).filter((board) => !listedIds.has(board.id))
    : [];
  const boardOptions = [...listed, ...matches].map((board) => {
    const { primary, secondary } = boardLabels(board);
    return {
      value: String(board.id),
      label: boardSearchText(board),
      primary,
      secondary,
    };
  });
  // A stored board name is the display fallback until the live list loads or when it was cleared.
  const selectedBoardLabel = integration.boardId
    ? (boardOptions.find((option) => option.value === integration.boardId)
        ?.primary ??
      integration.boardName ??
      integration.boardId)
    : null;

  return (
    <SettingsCardItem
      title={t("settings.jira.boardLabel")}
      description={t("settings.jira.boardDescription")}
      action={
        <Combobox
          options={boardOptions}
          value={integration.boardId ?? ""}
          width="w-72"
          triggerClassName="shrink-0"
          placeholder={t("settings.jira.boardPlaceholder")}
          searchPlaceholder={t("settings.jira.boardSearchPlaceholder")}
          filter={boardSearchFilter}
          onSearchChange={setSearch}
          emptyMessage={
            boards.isPending ||
            search.trim() !== query ||
            (query !== "" && searched.isFetching)
              ? t("settings.jira.loadingBoards")
              : t("settings.jira.noBoardsMatch")
          }
          renderTrigger={() => (
            <Button
              variant="outline"
              role="combobox"
              className="w-72 justify-between font-normal"
            >
              <span className="truncate">
                {selectedBoardLabel ?? t("settings.jira.boardPlaceholder")}
              </span>
              <ChevronSelectorVertical className="opacity-50 shrink-0" />
            </Button>
          )}
          renderItem={(option, isSelected) => (
            <div className="flex items-start gap-2 min-w-0 w-full">
              <div className="min-w-0 flex-1">
                <p className="truncate">{option.primary as string}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {option.secondary as string}
                </p>
              </div>
              <Check
                className={cn(
                  "mt-0.5 shrink-0",
                  isSelected ? "opacity-100" : "opacity-0",
                )}
              />
            </div>
          )}
          onChange={(boardId) => {
            if (!boardId || boardId === integration.boardId) return;
            upsert.mutate(
              {
                boardId,
                boardName:
                  boardOptions.find((option) => option.value === boardId)
                    ?.primary ?? null,
              },
              {
                onError: (err) =>
                  toast.error(errorMessage(err, t("settings.jira.saveFailed"))),
              },
            );
          }}
        />
      }
    />
  );
}

/**
 * One card per Jira STATUS on the selected board. A Jira column is a bucket of
 * statuses, so the card is headed by the column and names the status beneath
 * it whenever that adds information. Automations are keyed by status name, and
 * a status holds one per origin.
 */
function AutomationsRow({ boardId }: { boardId: string }) {
  const t = useT();
  const columns = useJiraBoardColumns(boardId);
  const automations = useJiraAutomations();

  let body: ReactNode;
  if (columns.isPending || automations.isPending) {
    body = <Skeleton className="h-40 w-full" />;
  } else if (columns.isError) {
    body = (
      <p className="text-xs text-muted-foreground">
        {t("settings.jira.columnsFailed")}
      </p>
    );
  } else if ((columns.data ?? []).length === 0) {
    body = (
      <p className="text-xs text-muted-foreground">
        {t("settings.jira.noColumnsYet")}
      </p>
    );
  } else {
    const rulesOf = new Map<string, JiraAutomation[]>();
    for (const rule of automations.data ?? []) {
      rulesOf.set(rule.jiraStatus, [
        ...(rulesOf.get(rule.jiraStatus) ?? []),
        rule,
      ]);
    }
    const allStatuses = (columns.data ?? []).flatMap((c) => c.statuses);
    body = (
      <div className="flex w-full flex-col gap-3">
        {(columns.data ?? []).flatMap((column) =>
          column.statuses.map((status) => (
            <StatusAutomationCard
              key={`${column.name}:${status}`}
              columnName={column.name}
              status={status}
              showStatus={status !== column.name || column.statuses.length > 1}
              rules={rulesOf.get(status) ?? []}
              otherStatuses={allStatuses.filter((s) => s !== status)}
            />
          )),
        )}
      </div>
    );
  }

  return (
    <SettingsCardItem
      title={t("settings.jira.automationsLabel")}
      description={t("settings.jira.automationsDescription")}
    >
      <div className="mt-3">{body}</div>
    </SettingsCardItem>
  );
}

/**
 * The issue field both manual actions share.
 *
 * It takes SEVERAL issues because that is how they are actually used: a person
 * pasting a column of links off a board, or typing a handful of keys. It parses
 * as you type and reports the count, so "10 issues" is visible BEFORE the
 * button that starts ten paid runs — and so a key it could not read is caught
 * here rather than discovered as a missing run afterwards.
 */
function IssueKeysField({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const t = useT();
  const { keys, invalid } = parseIssueKeys(value);
  return (
    <div className="flex w-full flex-col gap-1.5">
      <Textarea
        value={value}
        rows={3}
        disabled={disabled}
        onChange={(e: { target: { value: string } }) =>
          onChange(e.target.value)
        }
        placeholder={t("settings.jira.issueKeysPlaceholder")}
        aria-label={ariaLabel}
        className="font-mono text-xs"
        spellCheck={false}
      />
      {value.trim() !== "" && (
        <p className="text-xs text-muted-foreground">
          {t("settings.jira.issueKeysCount", { count: String(keys.length) })}
          {invalid.length > 0 && (
            <span className="text-destructive">
              {" · "}
              {t("settings.jira.issueKeysUnreadable", {
                items: invalid.slice(0, 3).join(", "),
              })}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * What one manual action reports back.
 *
 * A toast is the wrong shape for a batch: ten issues produce ten outcomes, and
 * the two that failed are the ones worth reading. So the result stays on the
 * card until the next run, with the failures named.
 */
function BatchResult({
  started,
  failed,
  startedLabel,
}: {
  started: string[];
  failed: Array<{ issueKey: string; error: string }>;
  startedLabel: string;
}) {
  if (started.length === 0 && failed.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/40 p-2.5 text-xs">
      {started.length > 0 && (
        <p>
          <Check size={12} className="mr-1 inline text-success" />
          {startedLabel}
          <span className="ml-1 font-mono">{started.join(", ")}</span>
        </p>
      )}
      {failed.map((f) => (
        <p key={f.issueKey} className="text-destructive">
          <span className="font-mono">{f.issueKey}</span> — {f.error}
        </p>
      ))}
    </div>
  );
}

/** A rule's identity within its status, for React keys and comparisons —
 *  the server's `fromKey`, which lower-cases and sorts a list the same way. */
function originKey(from: JiraRuleFrom): string {
  if (from.kind !== "statuses") return from.kind;
  const names = [...new Set(from.statuses.map((s) => s.trim().toLowerCase()))];
  return `statuses:${names.sort().join("\n")}`;
}

function OriginLabel({ from }: { from: JiraRuleFrom }) {
  const t = useT();
  switch (from.kind) {
    case "any":
      return <>{t("settings.jira.fromAny")}</>;
    case "earlier":
      return <>{t("settings.jira.fromEarlier")}</>;
    case "later":
      return <>{t("settings.jira.fromLater")}</>;
    case "statuses":
      return (
        <>
          {t("settings.jira.fromStatuses", {
            statuses: from.statuses.join(", "),
          })}
        </>
      );
  }
}

/** The automations on one status, one per origin, and the way to add another. */
function StatusAutomationCard({
  columnName,
  status,
  showStatus,
  rules,
  otherStatuses,
}: {
  columnName: string;
  status: string;
  showStatus: boolean;
  rules: JiraAutomation[];
  otherStatuses: string[];
}) {
  const t = useT();
  const { org } = useProjectContext();
  const navigate = useNavigate();
  const createAutomation = useCreateJiraAutomation();
  const [adding, setAdding] = useState(false);

  // Created with no prompt, so it opens where the prompt is written.
  const create = (from: JiraRuleFrom) =>
    createAutomation.mutate(
      { jiraStatus: status, from },
      {
        onSuccess: (automation) => {
          setAdding(false);
          void navigate({
            to: "/$org/projects/$agentId/automations/$automationId",
            params: {
              org: org.slug,
              agentId: getDecopilotId(org.id),
              automationId: automation.automationId,
            },
          });
        },
        onError: (err) =>
          toast.error(errorMessage(err, t("settings.jira.saveFailed"))),
      },
    );

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col min-w-0">
          <span className="truncate text-sm font-medium">{columnName}</span>
          {showStatus && (
            <span className="truncate text-xs text-muted-foreground">
              {status}
            </span>
          )}
        </div>
        {!adding && (
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setAdding(true)}
          >
            <Plus size={14} />
            {t("settings.jira.addAutomation")}
          </Button>
        )}
      </div>

      {adding && (
        <NewOriginRule
          taken={new Set(rules.map((r) => originKey(r.from)))}
          otherStatuses={otherStatuses}
          pending={createAutomation.isPending}
          onCreate={create}
          onCancel={() => setAdding(false)}
        />
      )}

      {rules.map((rule) => (
        <JiraAutomationRow key={rule.automationId} rule={rule} />
      ))}
    </div>
  );
}

/** Pick the origin a new automation on a status answers, any column by
 *  default. The kinds the status already has one for are not offered; a list
 *  can always be added. */
function NewOriginRule({
  taken,
  otherStatuses,
  pending,
  onCreate,
  onCancel,
}: {
  taken: Set<string>;
  otherStatuses: string[];
  pending: boolean;
  onCreate: (from: JiraRuleFrom) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const kinds = (["any", "earlier", "later", "statuses"] as const).filter(
    (kind) => kind === "statuses" || !taken.has(kind),
  );
  const [kind, setKind] = useState<JiraRuleFrom["kind"]>(
    kinds[0] ?? "statuses",
  );
  const [statuses, setStatuses] = useState<string[]>([]);
  const from: JiraRuleFrom =
    kind === "statuses" ? { kind, statuses } : { kind };
  const ready =
    (kind !== "statuses" || statuses.length > 0) && !taken.has(originKey(from));

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-2.5">
      <span className="text-xs font-medium">
        {t("settings.jira.originLabel")}
      </span>
      <Select
        value={kind}
        onValueChange={(v) => setKind(v as JiraRuleFrom["kind"])}
      >
        <SelectTrigger className="h-8 w-fit min-w-56 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {kinds.map((k) => (
            <SelectItem key={k} value={k} className="text-xs">
              {k === "any"
                ? t("settings.jira.fromAny")
                : k === "earlier"
                  ? t("settings.jira.fromEarlier")
                  : k === "later"
                    ? t("settings.jira.fromLater")
                    : t("settings.jira.fromStatuses", { statuses: "…" })}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {kind === "statuses" && (
        <MultiSelect
          options={otherStatuses.map((s) => ({ label: s, value: s }))}
          onValueChange={setStatuses}
          placeholder={t("settings.jira.originStatusesPlaceholder")}
          className="text-xs"
        />
      )}
      <p className="text-xs text-muted-foreground">
        {t("settings.jira.originHelp")}
      </p>
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("settings.jira.cancelRule")}
        </Button>
        <Button
          size="sm"
          disabled={!ready || pending}
          onClick={() => onCreate(from)}
        >
          {t("settings.jira.createRule")}
        </Button>
      </div>
    </div>
  );
}

/** One automation on a status: its origin, a link to edit it, and its switch. */
function JiraAutomationRow({ rule }: { rule: JiraAutomation }) {
  const t = useT();
  const { org } = useProjectContext();
  const listed = useAutomations().data?.find((a) => a.id === rule.automationId);
  const { update } = useAutomationActions();
  const active = listed?.active ?? rule.active;
  const name = listed?.name ?? rule.jiraStatus;

  return (
    <div className="flex items-center gap-3 rounded-lg bg-muted/40 px-2.5 py-2">
      <Link
        to="/$org/projects/$agentId/automations/$automationId"
        params={{
          org: org.slug,
          agentId: listed?.virtual_mcp_id ?? getDecopilotId(org.id),
          automationId: rule.automationId,
        }}
        className="flex min-w-0 flex-1 flex-col hover:underline"
      >
        <span className="truncate text-sm text-foreground">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          <OriginLabel from={rule.from} />
        </span>
      </Link>
      <Switch
        checked={active}
        disabled={update.isPending}
        onCheckedChange={(next) =>
          update.mutate({ id: rule.automationId, active: next })
        }
        aria-label={t("settings.jira.toggleAutomation", { name })}
      />
    </div>
  );
}

/**
 * Fire one of the automations above on issues, by hand — the answer to "will
 * this prompt do the right thing?" without waiting for a real transition. The
 * integration can be off, and the same issue can be re-run while the prompt
 * is reworded. These are real runs on the real issues, which is why the copy
 * says so.
 */
function TestRunRow() {
  const t = useT();
  const { org } = useProjectContext();
  const start = useStartJiraRun();
  const automations = useJiraAutomations();
  const [issueKeys, setIssueKeys] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [together, setTogether] = useState(false);
  const [result, setResult] = useState<{
    started: string[];
    failed: Array<{ issueKey: string; error: string }>;
    together: boolean;
  } | null>(null);
  const listed = useAutomations().data;
  // One entry per automation, though it can have several Jira starters.
  const rules = [
    ...new Map(
      (automations.data ?? []).map((rule) => [rule.automationId, rule]),
    ).values(),
  ];
  const automationId = picked ?? rules[0]?.automationId ?? null;
  const parsed = parseIssueKeys(issueKeys);
  const canRun =
    automationId !== null && parsed.keys.length > 0 && !start.isPending;
  const batch = together && parsed.keys.length > 1;

  const run = () => {
    if (!canRun || !automationId) return;
    setResult(null);
    start.mutate(
      {
        automationId,
        issueKey: issueKeys,
        ...(batch ? { together: true } : {}),
      },
      {
        onSuccess: (r) =>
          setResult({
            started: r.started.map((s) => s.issueKey),
            failed: r.failed,
            together: batch,
          }),
        onError: (err) =>
          toast.error(errorMessage(err, t("settings.jira.testRunFailed"))),
      },
    );
  };

  return (
    <SettingsCardItem
      title={t("settings.jira.testRunLabel")}
      description={t("settings.jira.testRunDescription")}
    >
      <div className="mt-3 flex w-full flex-col gap-3">
        <IssueKeysField
          value={issueKeys}
          onChange={setIssueKeys}
          disabled={start.isPending}
          ariaLabel={t("settings.jira.testRunIssueAriaLabel")}
        />
        {rules.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("settings.jira.testRunNoAutomations")}
          </p>
        ) : (
          <Select value={automationId ?? undefined} onValueChange={setPicked}>
            <SelectTrigger
              className="h-8 w-fit min-w-56 text-xs"
              aria-label={t("settings.jira.testRunAutomation")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rules.map((rule) => (
                <SelectItem
                  key={rule.automationId}
                  value={rule.automationId}
                  className="text-xs"
                >
                  {listed?.find((a) => a.id === rule.automationId)?.name ??
                    rule.jiraStatus}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {parsed.keys.length > 1 && (
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={together}
              onCheckedChange={(v) => setTogether(v === true)}
            />
            {t("settings.jira.together")}
          </label>
        )}
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {t("settings.jira.testRunHelp")}
          </p>
          <Button
            size="sm"
            className="shrink-0"
            disabled={!canRun}
            onClick={run}
          >
            <Play size={14} />
            {start.isPending
              ? t("settings.jira.testRunRunning")
              : t("settings.jira.testRun", {
                  count: String(parsed.keys.length || ""),
                })}
          </Button>
        </div>
        <BatchResult
          started={result?.started ?? []}
          failed={result?.failed ?? []}
          startedLabel={t(
            result?.together
              ? "settings.jira.togetherStarted"
              : "settings.jira.testRunStarted",
          )}
        />
        <Link
          to="/$org/settings/monitor"
          params={{ org: org.slug }}
          search={{ tab: "threads" }}
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground underline hover:text-foreground"
        >
          {t("settings.jira.testRunWatch")}
          <ArrowUpRight size={12} />
        </Link>
      </div>
    </SettingsCardItem>
  );
}

function EnabledRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();

  return (
    <SettingsCardItem
      title={t("settings.jira.enabledLabel")}
      description={t("settings.jira.enabledDescription")}
      action={
        <Switch
          checked={integration.enabled}
          disabled={upsert.isPending}
          onCheckedChange={(checked) => {
            if (checked && !integration.boardId) {
              toast.error(t("settings.jira.enableRequirements"));
              return;
            }
            upsert.mutate(
              { enabled: checked },
              {
                onError: (err) =>
                  toast.error(errorMessage(err, t("settings.jira.saveFailed"))),
              },
            );
          }}
        />
      }
    />
  );
}

function WebhookRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const webhookUrl = `${window.location.origin}/api/_jira/webhook/${integration.webhookSecret}`;

  return (
    <SettingsCardItem
      title={t("settings.jira.webhookTitle")}
      description={t("settings.jira.webhookDescription")}
    >
      <div className="flex flex-col gap-3 mt-3">
        <div className="flex items-center gap-2">
          <Input readOnly value={webhookUrl} className="font-mono text-xs" />
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => {
              void navigator.clipboard.writeText(webhookUrl);
              toast.success(t("settings.jira.webhookCopied"));
            }}
          >
            {t("settings.jira.webhookCopy")}
          </Button>
        </div>
        <SetupSteps
          stepKeys={[
            "settings.jira.webhookStep1",
            "settings.jira.webhookStep2",
            "settings.jira.webhookStep3",
            "settings.jira.webhookStep4",
            "settings.jira.webhookStep5",
          ]}
        />
      </div>
    </SettingsCardItem>
  );
}

function JiraContent() {
  const t = useT();
  const integration = useJiraIntegration();

  if (integration.isPending) {
    return (
      <SettingsCard>
        <div className="p-4">
          <Skeleton className="h-40 w-full" />
        </div>
      </SettingsCard>
    );
  }

  if (!integration.data) {
    return (
      <SettingsCard>
        <SettingsCardItem
          title={t("settings.jira.connectTitle")}
          description={t("settings.jira.connectDescription")}
        >
          <ConnectFormFields />
        </SettingsCardItem>
      </SettingsCard>
    );
  }

  const data = integration.data;
  return (
    <SettingsCard>
      <ConnectionRow integration={data} />
      <BoardRow integration={data} />
      {data.boardId && <AutomationsRow boardId={data.boardId} />}
      <TestRunRow />
      <EnabledRow integration={data} />
      <WebhookRow integration={data} />
    </SettingsCard>
  );
}

export function OrgTasksSettingsPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Container>
          <SettingsPage>
            <Page.Title>{t("settings.nav.tasks")}</Page.Title>
            <ReviewSettings />
            <TaskSystemPromptSettings />
            <AgentToolsSettings />
            <SettingsSection
              title={
                <span className="flex items-center gap-2">
                  <JiraIcon size={18} />
                  {t("settings.jira.sectionTitle")}
                </span>
              }
            >
              <JiraContent />
            </SettingsSection>
          </SettingsPage>
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
