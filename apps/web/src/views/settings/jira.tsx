/**
 * Settings → Tasks → "Jira integration" section — connect a Jira Cloud site
 * (email + API token), pick the board Studio watches, choose which statuses
 * start an agent run, and wire the webhook that tells it the moment an issue
 * moves.
 */

import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import {
  ArrowUpRight,
  Check,
  ChevronSelectorVertical,
  Plus,
  Trash01,
} from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Combobox } from "@decocms/ui/components/combobox.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
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
  type JiraIntegration,
  useDeleteJiraIntegration,
  useJiraAutomations,
  useJiraBoardColumns,
  useJiraBoards,
  useJiraIntegration,
  useSetJiraAutomation,
  useUpsertJiraIntegration,
} from "@/hooks/use-jira-integration";
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
 * it whenever that adds information. Rules are keyed by status name.
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
    const promptOf = new Map(
      (automations.data ?? []).map((a) => [a.jiraStatus, a.prompt]),
    );
    body = (
      <div className="flex w-full flex-col gap-3">
        {(columns.data ?? []).flatMap((column) =>
          column.statuses.map((status) => (
            <StatusAutomationCard
              key={`${column.name}:${status}`}
              columnName={column.name}
              status={status}
              showStatus={status !== column.name || column.statuses.length > 1}
              hasAutomation={promptOf.has(status)}
              prompt={promptOf.get(status) ?? null}
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

/** `prompt` null with `hasAutomation` true means the rule runs on the agent's
 *  own instruction; the status is absent from the automations list when there
 *  is no rule at all. */
function StatusAutomationCard({
  columnName,
  status,
  showStatus,
  hasAutomation,
  prompt,
}: {
  columnName: string;
  status: string;
  showStatus: boolean;
  hasAutomation: boolean;
  prompt: string | null;
}) {
  const t = useT();
  const setAutomation = useSetJiraAutomation();
  // A draft, so typing is not a write per keystroke. Re-seeded on change.
  const [draft, setDraft] = useState(prompt ?? "");
  const [syncedWith, setSyncedWith] = useState(prompt);
  if (syncedWith !== prompt) {
    setSyncedWith(prompt);
    setDraft(prompt ?? "");
  }

  const save = (next: string | null) =>
    setAutomation.mutate(
      { jiraStatus: status, prompt: next },
      {
        onError: (err) =>
          toast.error(errorMessage(err, t("settings.jira.saveFailed"))),
      },
    );

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border p-3">
      <div className="flex flex-col min-w-0">
        <span className="truncate text-sm font-medium">{columnName}</span>
        {showStatus && (
          <span className="truncate text-xs text-muted-foreground">
            {status}
          </span>
        )}
      </div>

      {hasAutomation ? (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium">
              {t("settings.jira.automationOn")}
            </span>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t("settings.jira.removeAriaLabel", { status })}
              onClick={() => save(null)}
            >
              <Trash01 size={14} />
            </Button>
          </div>
          <Textarea
            value={draft}
            rows={2}
            placeholder={t("settings.jira.promptPlaceholder")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft !== (prompt ?? "")) save(draft);
            }}
            data-jira-automation-prompt={status}
          />
          <p className="text-xs text-muted-foreground">
            {t("settings.jira.promptHelp")}
          </p>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="w-fit"
          onClick={() => save("")}
        >
          <Plus size={14} />
          {t("settings.jira.addAutomation")}
        </Button>
      )}
    </div>
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
        <Page.Body>
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
        </Page.Body>
      </Page.Content>
    </Page>
  );
}
