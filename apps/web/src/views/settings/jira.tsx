/**
 * Settings → Tasks → "Jira integration" section — connect a Jira Cloud site
 * (email + API token), pick the board to mirror, and map its columns onto the
 * board lanes. Issue fields are pull-only (cards update every ~10 minutes, or
 * in seconds with the webhook); comments flow both ways via the integration
 * account.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { Page } from "@/components/page";
import { JiraIcon } from "@/components/icons/jira-icon";
import {
  SettingsPage,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en";
import {
  type JiraIntegration,
  useDeleteJiraIntegration,
  useJiraBoardColumns,
  useJiraBoards,
  useJiraIntegration,
  useRunJiraSync,
  useUpsertJiraIntegration,
} from "@/hooks/use-jira-integration";
import { timeAgo } from "@/layouts/library/cards";

type BoardStatus = JiraIntegration["statusMapping"][string];

const BOARD_STATUS_OPTIONS: Array<{
  value: BoardStatus;
  labelKey: TranslationKey;
}> = [
  { value: "triage", labelKey: "taskBoard.config.statusBacklog" },
  { value: "todo", labelKey: "taskBoard.config.statusTodo" },
  { value: "in_progress", labelKey: "taskBoard.config.statusInProgress" },
  { value: "in_review", labelKey: "taskBoard.config.statusInReview" },
  { value: "done", labelKey: "taskBoard.config.statusDone" },
  { value: "archived", labelKey: "taskBoard.config.statusArchived" },
];

/** Radix Select forbids empty item values — sentinel for "not synced". */
const DONT_SYNC = "__dont_sync__";

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

const CREATE_TOKEN_URL =
  "https://id.atlassian.com/manage-profile/security/api-tokens";

/** Sub-block inside the "Jira integration" section — smaller header than a
 *  top-level SettingsSection, same title/description/actions shape. */
function SubSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex flex-col gap-0.5">
          <h3 className="text-sm font-medium leading-tight">{title}</h3>
          {description && (
            <p className="text-xs text-muted-foreground leading-snug">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

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

function ConnectForm() {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");
  const canConnect =
    siteUrl.trim() !== "" && email.trim() !== "" && apiToken.trim() !== "";

  return (
    <SubSection
      title={t("settings.jira.connectTitle")}
      description={t("settings.jira.connectDescription")}
    >
      <div className="rounded-2xl border border-border/60 bg-background p-5 flex flex-col gap-3 max-w-lg">
        <SetupSteps
          stepKeys={[
            "settings.jira.connectStep1",
            "settings.jira.connectStep2",
            "settings.jira.connectStep3",
          ]}
        />
        <a
          href={CREATE_TOKEN_URL}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-foreground hover:underline w-fit"
        >
          {t("settings.jira.createTokenLink")} ↗
        </a>
        <Input
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          placeholder={t("settings.jira.sitePlaceholder")}
          autoComplete="off"
        />
        <Input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("settings.jira.emailPlaceholder")}
          autoComplete="off"
        />
        <Input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={t("settings.jira.tokenPlaceholder")}
          autoComplete="off"
        />
        <div>
          <Button
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
      </div>
    </SubSection>
  );
}

function SyncStatusLine({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  if (integration.lastSyncError) {
    return (
      <p className="text-xs text-destructive truncate">
        {integration.lastSyncError}
      </p>
    );
  }
  return (
    <p className="text-xs text-muted-foreground">
      {integration.lastSyncedAt
        ? t("settings.jira.lastSynced", {
            ago: timeAgo(integration.lastSyncedAt),
          })
        : t("settings.jira.waitingFirstSync")}
    </p>
  );
}

function ColumnMappingRows({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const columns = useJiraBoardColumns(integration.boardId);

  if (columns.isPending) return <Skeleton className="h-24 w-full" />;
  if (columns.isError) {
    return (
      <p className="text-xs text-destructive">
        {errorMessage(columns.error, t("settings.jira.columnsFailed"))}
      </p>
    );
  }

  // The mapping is keyed by STATUS name; one row writes every status its column groups.
  function setColumnMapping(statuses: string[], value: string) {
    const next = { ...integration.statusMapping };
    for (const status of statuses) {
      if (value === DONT_SYNC) {
        delete next[status];
      } else {
        next[status] = value as BoardStatus;
      }
    }
    upsert.mutate(
      { statusMapping: next },
      {
        onError: (err) =>
          toast.error(errorMessage(err, t("settings.jira.saveFailed"))),
      },
    );
  }

  return (
    <div className="flex flex-col">
      {(columns.data ?? []).map((column) => (
        <div
          key={column.name}
          className="flex items-center justify-between gap-4 py-2.5 border-b border-border/60 last:border-b-0"
        >
          <div className="min-w-0">
            <span className="text-sm truncate">{column.name}</span>
            {(column.statuses.length > 1 ||
              column.statuses[0] !== column.name) && (
              <p className="text-xs text-muted-foreground truncate">
                {column.statuses.join(", ")}
              </p>
            )}
          </div>
          <Select
            value={
              (column.statuses[0] &&
                integration.statusMapping[column.statuses[0]]) ??
              DONT_SYNC
            }
            onValueChange={(value) => setColumnMapping(column.statuses, value)}
          >
            <SelectTrigger className="w-44 shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DONT_SYNC}>
                {t("settings.jira.dontSync")}
              </SelectItem>
              {BOARD_STATUS_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ))}
    </div>
  );
}

function JqlFilterField({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const [value, setValue] = useState(integration.jqlFilter ?? "");
  const dirty = value.trim() !== (integration.jqlFilter ?? "");

  return (
    <div className="flex flex-col gap-1">
      <p className="text-sm font-medium">{t("settings.jira.jqlLabel")}</p>
      <p className="text-xs text-muted-foreground">
        {t("settings.jira.jqlDescription")}
      </p>
      <div className="flex items-center gap-2 mt-1">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("settings.jira.jqlPlaceholder")}
          className="font-mono text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          disabled={!dirty || upsert.isPending}
          onClick={() =>
            upsert.mutate(
              { jqlFilter: value.trim() === "" ? null : value.trim() },
              {
                onSuccess: () => toast.success(t("settings.jira.jqlSaved")),
                onError: (err) =>
                  toast.error(errorMessage(err, t("settings.jira.saveFailed"))),
              },
            )
          }
        >
          {t("settings.jira.jqlSave")}
        </Button>
      </div>
    </div>
  );
}

function SyncSettings({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const runSync = useRunJiraSync();
  const boards = useJiraBoards(true);
  const hasMapping = Object.keys(integration.statusMapping).length > 0;

  return (
    <SubSection
      title={t("settings.jira.syncTitle")}
      description={t("settings.jira.syncDescription")}
    >
      <div className="rounded-2xl border border-border/60 bg-background p-5 flex flex-col gap-5">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {t("settings.jira.boardLabel")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.jira.boardDescription")}
            </p>
          </div>
          <Select
            value={integration.boardId ?? undefined}
            onValueChange={(boardId) =>
              upsert.mutate(
                // New board = new columns, so the old mapping resets with it —
                // and the sync goes off with it, because an enabled sync with no
                // mapping is exactly what the server refuses.
                {
                  boardId,
                  boardName:
                    boards.data?.find((b) => String(b.id) === boardId)?.name ??
                    null,
                  statusMapping: {},
                  enabled: false,
                },
                {
                  onError: (err) =>
                    toast.error(
                      errorMessage(err, t("settings.jira.saveFailed")),
                    ),
                },
              )
            }
          >
            <SelectTrigger className="w-64 shrink-0">
              <SelectValue placeholder={t("settings.jira.boardPlaceholder")}>
                {integration.boardName ?? integration.boardId ?? undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {boards.isPending && (
                <SelectItem value="__loading__" disabled>
                  {t("settings.jira.loadingBoards")}
                </SelectItem>
              )}
              {(boards.data ?? []).map((board) => (
                <SelectItem key={board.id} value={String(board.id)}>
                  {board.name}
                  {board.projectKey ? ` (${board.projectKey})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {integration.boardId && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">
              {t("settings.jira.mappingLabel")}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("settings.jira.mappingDescription")}
            </p>
            <ColumnMappingRows integration={integration} />
          </div>
        )}

        {integration.boardId && <JqlFilterField integration={integration} />}

        {integration.boardId && (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {t("settings.jira.autoDelegateLabel")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("settings.jira.autoDelegateDescription")}
              </p>
            </div>
            <Switch
              checked={integration.autoDelegate}
              disabled={upsert.isPending}
              onCheckedChange={(checked) =>
                upsert.mutate(
                  { autoDelegate: checked },
                  {
                    onError: (err) =>
                      toast.error(
                        errorMessage(err, t("settings.jira.saveFailed")),
                      ),
                  },
                )
              }
            />
          </div>
        )}

        <div className="flex items-center justify-between gap-4 border-t border-border/60 pt-4">
          <div className="min-w-0 flex flex-col gap-0.5">
            <p className="text-sm font-medium">
              {t("settings.jira.enableLabel")}
            </p>
            <SyncStatusLine integration={integration} />
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Button
              variant="outline"
              size="sm"
              disabled={!integration.enabled || runSync.isPending}
              onClick={() =>
                runSync.mutate(undefined, {
                  onSuccess: (result) => {
                    if ("error" in result) {
                      toast.error(result.error);
                    } else {
                      toast.success(
                        t("settings.jira.syncDone", {
                          created: String(result.created),
                          updated: String(result.updated),
                        }),
                      );
                    }
                  },
                  onError: (err) =>
                    toast.error(
                      errorMessage(err, t("settings.jira.syncFailed")),
                    ),
                })
              }
            >
              {runSync.isPending
                ? t("settings.jira.syncing")
                : t("settings.jira.syncNow")}
            </Button>
            <Switch
              checked={integration.enabled}
              disabled={upsert.isPending}
              onCheckedChange={(checked) => {
                if (checked && (!integration.boardId || !hasMapping)) {
                  toast.error(t("settings.jira.enableRequirements"));
                  return;
                }
                upsert.mutate(
                  { enabled: checked },
                  {
                    onError: (err) =>
                      toast.error(
                        errorMessage(err, t("settings.jira.saveFailed")),
                      ),
                  },
                );
              }}
            />
          </div>
        </div>
      </div>
    </SubSection>
  );
}

function WebhookSection({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const webhookUrl = `${window.location.origin}/api/_jira/webhook/${integration.webhookSecret}`;

  return (
    <SubSection
      title={t("settings.jira.webhookTitle")}
      description={t("settings.jira.webhookDescription")}
    >
      <div className="rounded-2xl border border-border/60 bg-background p-5 flex flex-col gap-4">
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
    </SubSection>
  );
}

function ConnectionCard({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const remove = useDeleteJiraIntegration();
  const [confirmOpen, setConfirmOpen] = useState(false);

  return (
    <SubSection
      title={t("settings.jira.connectionTitle")}
      actions={
        <Button
          variant="outline"
          size="sm"
          onClick={() => setConfirmOpen(true)}
        >
          {t("settings.jira.disconnect")}
        </Button>
      }
    >
      <div className="rounded-2xl border border-border/60 bg-background px-5 py-4">
        <p className="text-sm font-medium truncate">{integration.siteUrl}</p>
        <p className="text-xs mt-0.5 truncate text-muted-foreground">
          {integration.email}
        </p>
      </div>

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
    </SubSection>
  );
}

function JiraContent() {
  const integration = useJiraIntegration();
  if (integration.isPending) return <Skeleton className="h-40 w-full" />;
  if (!integration.data) return <ConnectForm />;
  return (
    <>
      <ConnectionCard integration={integration.data} />
      <SyncSettings integration={integration.data} />
      <WebhookSection integration={integration.data} />
    </>
  );
}

export function OrgTasksSettingsPage() {
  const t = useT();
  return (
    <Page>
      <Page.Content>
        <Page.Body>
          <SettingsPage>
            <Page.Title>{t("settings.nav.tasks")}</Page.Title>
            <SettingsSection
              title={
                <span className="flex items-center gap-2">
                  <JiraIcon size={18} />
                  {t("settings.jira.sectionTitle")}
                </span>
              }
              description={t("settings.jira.pageDescription")}
            >
              <div className="flex flex-col gap-8">
                <JiraContent />
              </div>
            </SettingsSection>
          </SettingsPage>
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
