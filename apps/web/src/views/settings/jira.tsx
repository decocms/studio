/**
 * Settings → Board → "Jira integration" section — connect a Jira Cloud site
 * (email + API token), pick the board to mirror, and map its columns onto the
 * board lanes. Issue fields are pull-only (cards update every ~10 minutes, or
 * in seconds with the webhook); comments flow both ways via the integration
 * account.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  ArrowUpRight,
  Check,
  ChevronSelectorVertical,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
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
import { ReviewSettings } from "@/components/settings/review-settings";
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

  if (columns.isPending) return <Skeleton className="h-24 w-full mt-3" />;
  if (columns.isError) {
    return (
      <p className="text-xs text-destructive mt-3">
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
    <div className="flex flex-col mt-3">
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
  const boardOptions = (boards.data ?? []).map((board) => {
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
          emptyMessage={
            boards.isPending
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
            // A new board resets the (now stale) column mapping and disables the sync until it's remapped.
            upsert.mutate(
              {
                boardId,
                boardName:
                  boardOptions.find((option) => option.value === boardId)
                    ?.primary ?? null,
                statusMapping: {},
                enabled: false,
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

function MappingRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  return (
    <SettingsCardItem
      title={t("settings.jira.mappingLabel")}
      description={t("settings.jira.mappingDescription")}
    >
      <ColumnMappingRows integration={integration} />
    </SettingsCardItem>
  );
}

function JqlRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const [value, setValue] = useState(integration.jqlFilter ?? "");
  const dirty = value.trim() !== (integration.jqlFilter ?? "");

  return (
    <SettingsCardItem
      title={t("settings.jira.jqlLabel")}
      description={t("settings.jira.jqlDescription")}
    >
      <div className="flex items-center gap-2 mt-3">
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
    </SettingsCardItem>
  );
}

function AutoDelegateRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  return (
    <SettingsCardItem
      title={t("settings.jira.autoDelegateLabel")}
      description={t("settings.jira.autoDelegateDescription")}
      action={
        <Switch
          checked={integration.autoDelegate}
          disabled={upsert.isPending}
          onCheckedChange={(checked) =>
            upsert.mutate(
              { autoDelegate: checked },
              {
                onError: (err) =>
                  toast.error(errorMessage(err, t("settings.jira.saveFailed"))),
              },
            )
          }
        />
      }
    />
  );
}

function SyncRow({ integration }: { integration: JiraIntegration }) {
  const t = useT();
  const upsert = useUpsertJiraIntegration();
  const runSync = useRunJiraSync();
  const hasMapping = Object.keys(integration.statusMapping).length > 0;

  return (
    <SettingsCardItem
      title={t("settings.jira.enableLabel")}
      description={<SyncStatusLine integration={integration} />}
      action={
        <div className="flex items-center gap-3">
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
                  toast.error(errorMessage(err, t("settings.jira.syncFailed"))),
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
      {data.boardId && <MappingRow integration={data} />}
      {data.boardId && <JqlRow integration={data} />}
      {data.boardId && <AutoDelegateRow integration={data} />}
      <SyncRow integration={data} />
      <WebhookRow integration={data} />
    </SettingsCard>
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
            <ReviewSettings />
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
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
