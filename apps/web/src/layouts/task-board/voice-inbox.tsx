import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MicrophoneOff01,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@decocms/ui/components/dropdown-menu.tsx";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/resizable";
import { OrgSearch } from "@/components/sidebar/org-search";
import { authClient, useActiveOrganizations } from "@/lib/auth-client";
import { useProjectContext } from "@/sdk";
import {
  useTaskBoardItems,
  useTaskBoardItemActions,
} from "@/hooks/use-task-board-items";
import { useTaskBoardComments } from "@/hooks/use-task-board-comments";
import { useProjectIndex } from "@/hooks/use-project-index";
import { entryForTask, stampableEntries, stampFor } from "@/lib/project-index";
import { useT } from "@/i18n/use-t";
import { toast } from "sonner";
import { TaskBoardItemDetail } from "./task-dialog";
import { TaskProjectPicker } from "./task-project-picker";
import { TaskPreview } from "./task-preview";
import { NewCommentComposer } from "./task-comments";
import { isLiveAttempt } from "./config";
import "@/components/chat/voice/voice.css";

/** Reads the same board cache and writes through the same actions as task detail. */
export function VoiceInbox() {
  const t = useT();
  const { org } = useProjectContext();
  const { data: organizations } = useActiveOrganizations();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const { data: session } = authClient.useSession();
  const { items, isLoading, error } = useTaskBoardItems();
  const actions = useTaskBoardItemActions();
  const index = useProjectIndex(items);
  const [mine, setMine] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const available = items
    .filter((item) => !["done", "archived"].includes(item.status))
    .filter((item) => !mine || item.assigneeId === session?.user.id)
    .filter((item) => !dismissed.includes(item.id))
    .toSorted((a, b) => a.sortOrder - b.sortOrder);
  const task = available.find((item) => item.id === selectedId) ?? available[0];
  const comments = useTaskBoardComments(task?.id);
  const entry = task ? entryForTask(task, index) : null;
  const close = () =>
    void navigate({
      to: "/$org/tasks/{-$taskKey}",
      params: { org: org.slug, taskKey: undefined },
      search: {},
    });
  const move = (direction: number) => {
    if (!task || !available.length) return;
    const position = available.findIndex((item) => item.id === task.id);
    setSelectedId(
      available[(position + direction + available.length) % available.length]!
        .id,
    );
  };
  return createPortal(
    <div
      data-testid="voice-inbox"
      className="fixed inset-0 z-40 flex h-dvh flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="flex h-14 shrink-0 items-center gap-2 px-3 sm:px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("voiceInbox.back")}
          onClick={close}
        >
          <ChevronLeft />
        </Button>
        <nav
          aria-label={t("voiceInbox.breadcrumb")}
          className="flex min-w-0 items-center gap-1"
        >
          <OrgSearch
            orgs={organizations ?? []}
            currentSlug={org.slug}
            hiddenCount={0}
            onSelect={(slug) => {
              setSelectedId(null);
              setDismissed([]);
              void navigate({
                to: "/$org/tasks/{-$taskKey}",
                params: { org: slug, taskKey: undefined },
                search: { voice: true },
              });
            }}
            trigger={
              <>
                {org.logo && (
                  <img
                    src={org.logo}
                    alt=""
                    className="size-5 shrink-0 rounded object-contain"
                  />
                )}
                <span className="max-w-24 truncate">{org.name}</span>
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              </>
            }
          />
          {task && (
            <>
              <span
                aria-hidden
                className="px-1 text-sm leading-5 text-muted-foreground/50"
              >
                /
              </span>
              <TaskProjectPicker
                entries={stampableEntries(index)}
                selectedEntry={entry ?? undefined}
                fallbackLabel={task.repo ?? undefined}
                showIcon={false}
                className="focus-ring flex h-8 min-w-0 items-center rounded-md px-2 text-sm font-medium leading-5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onSelect={(project) =>
                  actions.update.mutate({ id: task.id, ...stampFor(project) })
                }
              />
            </>
          )}
        </nav>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setMine(!mine);
              setSelectedId(null);
            }}
          >
            {t(mine ? "voiceInbox.mine" : "voiceInbox.allActive")}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                {available.length}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="max-h-80 w-80 overflow-y-auto"
            >
              {available.map((item) => (
                <DropdownMenuItem
                  key={item.id}
                  onSelect={() => setSelectedId(item.id)}
                >
                  {item.title}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("voiceInbox.previousTask")}
            disabled={!task}
            onClick={() => move(-1)}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("voiceInbox.nextTask")}
            disabled={!task}
            onClick={() => move(1)}
          >
            <ChevronRight />
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 px-3">
        {error ? (
          <p role="alert" className="p-6">
            {error.message}
          </p>
        ) : isLoading ? (
          <p className="p-6 text-muted-foreground">
            {t("voiceInbox.loadingBoard")}
          </p>
        ) : task ? (
          <ResizablePanelGroup orientation="horizontal" id="voice-live-split">
            {!mobile && (
              <>
                <ResizablePanel
                  defaultSize="65%"
                  minSize="20%"
                  className="min-h-0 p-0.5"
                >
                  <TaskPreview item={task} />
                </ResizablePanel>
                <ResizableHandle
                  className="w-1 shrink-0 bg-transparent"
                  aria-label={t("voiceInbox.resizePanels")}
                />
              </>
            )}
            <ResizablePanel
              defaultSize={mobile ? "100%" : "35%"}
              minSize="30%"
              className="flex min-h-0 min-w-0 p-0.5"
            >
              <div className="surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
                <TaskBoardItemDetail
                  key={task.id}
                  item={task}
                  embedded
                  hideComposer
                  onClose={close}
                  onSubmit={(input) =>
                    actions.update.mutate({ id: task.id, ...input })
                  }
                  onSetSprint={(sprintId) =>
                    actions.update.mutate({ id: task.id, sprintId })
                  }
                  headerActions={
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setDismissed([...dismissed, task.id])}
                      >
                        {t("voiceInbox.dismiss")}
                      </Button>
                      {task.status === "customer_approval" && (
                        <Button
                          size="sm"
                          variant="success"
                          disabled={actions.update.isPending}
                          onClick={() =>
                            actions.update.mutate({
                              id: task.id,
                              status: "ready_for_deployment",
                            })
                          }
                        >
                          {t("voiceInbox.approveAction")}
                        </Button>
                      )}
                    </>
                  }
                />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            {t("voiceInbox.emptyLive")}
          </div>
        )}
      </main>
      {task && (
        <footer className="mx-auto my-2 flex w-full max-w-4xl shrink-0 items-center gap-3 px-4 sm:px-6">
          <div
            aria-hidden
            className="studio-voice-orb"
            data-size="compact"
            data-phase="idle"
            data-muted
          />
          <div className="min-w-0 flex-1">
            <NewCommentComposer
              key={task.id}
              compact
              agentRoute={
                task.threads.some((run) => isLiveAttempt(run))
                  ? "steer"
                  : "start"
              }
              placeholder={t("voiceInbox.livePlaceholder")}
              trailingActions={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled
                  aria-label={t("voiceInbox.voiceUnavailable")}
                  title={t("voiceInbox.voiceUnavailable")}
                >
                  <MicrophoneOff01 />
                </Button>
              }
              onSubmit={async (body) => {
                try {
                  await comments.post.mutateAsync({ body });
                  return true;
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t("taskBoard.conversation.sendFailed"),
                  );
                  return false;
                }
              }}
            />
          </div>
        </footer>
      )}
    </div>,
    document.body,
  );
}
