import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/resizable";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import { TaskPreview } from "@/layouts/task-board/task-preview";
import { MockProjectPicker } from "./project-picker";
import { MockTaskDetail } from "./task-detail";
import { setMockTasks } from "./mock-api";
import { useRef, useState, type ReactNode } from "react";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from "@decocms/ui/components/popover.tsx";
import {
  ArrowRight,
  DotsHorizontal,
  Check,
  ChevronLeft,
  Headphones01,
  Microphone01,
  MicrophoneOff01,
  Moon01,
  RefreshCw01,
  Sun,
  X,
} from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { NewCommentComposer } from "@/layouts/task-board/task-comments";
import { parseMentions } from "@decocms/shared/mentions";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { TaskCard } from "@/layouts/task-board";
import {
  laneHeader,
  SUPER_AGENT_ASSIGNEE_ID,
  type TaskBoardItemStatus,
} from "@/layouts/task-board/config";
import { useT, type TranslationKey } from "@/i18n/use-t";
import { initialTasks, needsPerson, PERSON, type MockTask } from "./data";
import "@/components/chat/voice/voice.css";
import "./prototype.css";

import { InboxScope, OrganizationMark } from "./inbox-scope";
import {
  scenarioTasks,
  saveScenario,
  type Scenario,
  type Branding,
} from "./scenario-data";

type View = "welcome" | "inbox" | "conversation" | "board" | "outside";
const VIEWS: { view: View; label: TranslationKey }[] = [
  { view: "welcome", label: "voiceInbox.home" },
  { view: "inbox", label: "voiceInbox.pending" },
  { view: "conversation", label: "voiceInbox.talk" },
  { view: "board", label: "voiceInbox.board" },
];
const LANES: TaskBoardItemStatus[] = [
  "in_progress",
  "customer_approval",
  "ready_for_deployment",
  "done",
];
function Orb({
  small = false,
  muted = false,
}: {
  small?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "voice-inbox-orb studio-voice-orb",
        small && "voice-inbox-orb-small",
      )}
      data-phase="listening"
      data-muted={muted}
    />
  );
}
export function VoiceInboxPrototype({
  scenario,
  personName,
  organization,
  branding,
  mockControls,
}: {
  mockControls?: ReactNode;
  scenario?: Scenario;
  personName?: string;
  organization?: string;
  branding?: Branding;
}) {
  const t = useT();
  const isMobile = useIsMobile();
  const [scope, setScope] = useState<"user" | "organization">("organization");
  const orgName = organization ?? "Demo";
  const [tasks, updateTasks] = useState(() =>
    scenario ? scenarioTasks(scenario) : initialTasks(),
  );
  const person = { ...PERSON, user: { name: personName ?? PERSON.user.name } };
  setMockTasks(tasks, person.user.name, setTasks);
  const projectLabels = [
    ...new Set([
      ...(scenario?.tasks.flatMap((task) =>
        task.projectLabel ? [task.projectLabel] : [],
      ) ?? []),
      ...tasks.flatMap((task) =>
        task.projectLabel ? [task.projectLabel] : [],
      ),
    ]),
  ];
  function projectPicker(task: MockTask) {
    return (
      <MockProjectPicker
        label={task.projectLabel}
        labels={projectLabels}
        onChange={(projectLabel) =>
          setTasks(
            tasks.map((entry) =>
              entry.item.id === task.item.id
                ? { ...entry, projectLabel }
                : entry,
            ),
          )
        }
      />
    );
  }
  function setTasks(next: MockTask[] | ((current: MockTask[]) => MockTask[])) {
    const updated = typeof next === "function" ? next(tasks) : next;
    if (scenario) saveScenario(scenario, updated);
    updateTasks(updated);
  }
  const [view, setView] = useState<View>(() =>
    tasks.some(needsPerson) ? "inbox" : "welcome",
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [notice, setNotice] = useState<TranslationKey | null>(null);
  const [muted, setMuted] = useState(false);
  const [dark, setDark] = useState(false);
  const swipeStart = useRef<{
    pointerId: number;
    x: number;
    y: number;
    taskId: string;
  } | null>(null);
  const pending = tasks
    .filter(needsPerson)
    .toSorted((a, b) => a.item.sortOrder - b.item.sortOrder);
  const focused =
    pending.find((task) => task.item.id === focusedId) ?? pending[0];
  const detail = tasks.find((task) => task.item.id === detailId);
  const isFocused = view === "inbox" && !!focused;
  const showCompanion = view !== "welcome" && view !== "outside";
  function navigate(next: View) {
    document.getElementById("voice-inbox-main")?.scrollTo({ top: 0 });
    setView(next);
    setNotice(null);
  }
  function reset() {
    const restored = scenario ? scenarioTasks(scenario, false) : initialTasks();
    setTasks(restored);
    setFocusedId(null);
    setDetailId(null);
    setNotice(null);
    setView(restored.some(needsPerson) ? "inbox" : "welcome");
  }
  function decide(kind: "confirm" | "steer", text?: string) {
    if (!focused) {
      setNotice("voiceInbox.noFocus");
      return;
    }
    const targetId = focused.item.id;
    const body =
      text ??
      focused.confirmLabel ??
      (focused.item.status === "customer_approval"
        ? t("voiceInbox.approve")
        : t("voiceInbox.confirm"));
    setTasks((current) =>
      current.map((task): MockTask => {
        if (task.item.id !== targetId) return task;
        return {
          ...task,
          item: {
            ...task.item,
            status:
              kind === "confirm" && task.item.status === "customer_approval"
                ? "ready_for_deployment"
                : "in_progress",
            assigneeId: SUPER_AGENT_ASSIGNEE_ID,
            threads: task.item.threads.map((thread) => ({
              ...thread,
              status: "in_progress",
            })),
            updatedBy: PERSON.userId,
            updatedAt: new Date().toISOString(),
          },
          comments: [
            ...task.comments.map((comment) =>
              comment.mentionUserId === PERSON.userId
                ? { ...comment, resolved: true }
                : comment,
            ),
            { id: crypto.randomUUID(), author: "person", body },
          ],
        };
      }),
    );
    setNotice(
      kind === "confirm" ? "voiceInbox.recorded" : "voiceInbox.steered",
    );
    setFocusedId(null);
  }
  function nextTask() {
    if (!focused) return;
    const nextOrder = Math.max(...tasks.map((task) => task.item.sortOrder)) + 1;
    setTasks((current) =>
      current.map((task) =>
        task.item.id === focused.item.id
          ? { ...task, item: { ...task.item, sortOrder: nextOrder } }
          : task,
      ),
    );
    setFocusedId(null);
    setNotice("voiceInbox.skipped");
  }
  function submit(body: string) {
    const text = body.trim();
    if (!text) return false;
    if (!isFocused) {
      setNotice("voiceInbox.noFocus");
      return false;
    }
    if (parseMentions(text).includes(SUPER_AGENT_ASSIGNEE_ID)) {
      decide("steer", text);
      return true;
    }
    if (/^(sim|aprova|aprovar|pode|segue)[.! ]*$/i.test(text))
      decide("confirm", text);
    else if (/^(depois|próxima|proxima)[.! ]*$/i.test(text)) {
      nextTask();
    } else decide("steer", text);
    return true;
  }
  function renderBoard() {
    return (
      <section className="w-full max-w-6xl px-5 sm:px-10">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">
              {t(
                view === "outside" ? "voiceInbox.outside" : "voiceInbox.board",
              )}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("voiceInbox.boardHint")}
            </p>
          </div>
          {view === "outside" && (
            <Button
              onClick={() => navigate(pending.length ? "inbox" : "welcome")}
            >
              <Headphones01 />
              {t("voiceInbox.enter")}
            </Button>
          )}
        </div>
        <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
          {LANES.map((status) => {
            const lane = laneHeader(status, t);
            const Icon = lane.visual.icon;
            const items = tasks.filter((task) => task.item.status === status);
            return (
              <section key={status} className="min-w-0">
                <div className="mb-3 flex items-center gap-2 px-1 text-sm">
                  <Icon size={15} className={lane.visual.iconClassName} />
                  <span>{lane.label}</span>
                  <span className="text-muted-foreground">{items.length}</span>
                </div>
                <div className="flex flex-col gap-3">
                  {items.map((task) => (
                    <TaskCard
                      key={task.item.id}
                      item={task.item}
                      assignee={person}
                      assignedBy={person}
                      className="w-full"
                      onOpen={() => setDetailId(task.item.id)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    );
  }
  return (
    <div className="voice-inbox-prototype flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2 pl-3 pr-14 sm:pl-6 sm:pr-16">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("voiceInbox.back")}
          onClick={() =>
            navigate(
              view === "outside"
                ? pending.length
                  ? "inbox"
                  : "welcome"
                : "outside",
            )
          }
        >
          <ChevronLeft />
        </Button>
        <InboxScope
          organization={orgName}
          branding={branding}
          scope={scope}
          onScopeChange={setScope}
        />
        {isFocused && (
          <>
            {scope === "user" && (
              <span className="truncate text-sm text-muted-foreground">
                {orgName}
              </span>
            )}
            {focused.projectLabel && (
              <div className="flex min-w-0 items-center gap-1">
                <span aria-hidden="true" className="text-muted-foreground">
                  /
                </span>
                {projectPicker(focused)}
              </div>
            )}
            <span className="ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {t(
                pending.length === 1
                  ? "voiceInbox.oneRemaining"
                  : "voiceInbox.remaining",
                { count: pending.length },
              )}
            </span>
          </>
        )}
      </header>
      <main
        id="voice-inbox-main"
        className={cn(
          "flex min-h-0 flex-1 flex-col items-center",
          isFocused
            ? "overflow-hidden py-2"
            : "overflow-y-auto py-6 [&>section]:my-auto [&>section]:shrink-0",
          (view === "board" || view === "outside") && "pt-8 [&>section]:my-0",
        )}
      >
        {view === "welcome" && (
          <section className="flex w-full max-w-lg flex-col items-center px-6 text-center">
            <Orb />
            {scope === "organization" && branding?.logo ? (
              <div className="mb-6 flex flex-col items-center gap-3">
                <img
                  src={branding.logo}
                  alt={orgName}
                  className="h-6 w-48 object-contain brightness-0 dark:invert"
                />
              </div>
            ) : (
              <span className="mb-3 text-xs text-muted-foreground">
                {t("voiceInbox.allOrganizations")}
              </span>
            )}
            <h1 className="text-3xl font-medium tracking-tight">
              {t("voiceInbox.greeting", { name: person.user.name })}
            </h1>
            <p className="mt-4 max-w-80 text-sm leading-relaxed text-muted-foreground">
              {scenario &&
              !pending.length &&
              scenario.tasks.some((task) => task.status === "customer_approval")
                ? t("voiceInbox.empty")
                : (scenario?.summary ??
                  t("voiceInbox.intro", { count: pending.length }))}
            </p>
            <Button
              size="lg"
              className="mt-7"
              onClick={() => navigate(pending.length ? "inbox" : "board")}
            >
              {t(pending.length ? "voiceInbox.start" : "voiceInbox.board")}
              <ArrowRight />
            </Button>
            <Button
              variant="ghost"
              className="mt-3 text-muted-foreground"
              onClick={() => navigate("conversation")}
            >
              {t("voiceInbox.other")}
            </Button>
          </section>
        )}
        {view === "conversation" && (
          <section className="flex max-w-lg flex-col items-center px-6 text-center">
            <Orb />
            <h1 className="text-2xl font-medium tracking-tight">
              {t("voiceInbox.conversation")}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {t("voiceInbox.conversationHint")}
            </p>
            <Button
              className="mt-6"
              variant="ghost"
              onClick={() => navigate("inbox")}
            >
              {t("voiceInbox.showPending", { count: pending.length })}
              <ArrowRight />
            </Button>
          </section>
        )}
        {isFocused && (
          <section className="h-full min-h-0 w-full px-3">
            <ResizablePanelGroup
              orientation="horizontal"
              id="voice-inbox-split"
            >
              {!isMobile && (
                <>
                  <ResizablePanel
                    id="voice-inbox-preview"
                    defaultSize="55%"
                    minSize="20%"
                    className="min-h-0 min-w-0 p-0.5"
                  >
                    <TaskPreview item={focused.item} />
                  </ResizablePanel>
                  <ResizableHandle
                    className="w-1 shrink-0 bg-transparent"
                    aria-label={t("voiceInbox.resizePanels")}
                  />
                </>
              )}
              <ResizablePanel
                id="voice-inbox-task"
                defaultSize={isMobile ? "100%" : "45%"}
                minSize="30%"
                className="flex min-h-0 min-w-0 p-0.5"
              >
                <div className="flex min-h-0 flex-1 gap-4">
                  <div
                    className="voice-inbox-decision surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
                    style={{ touchAction: "pan-y" }}
                    onPointerDown={(event) => {
                      swipeStart.current = null;
                      if (
                        event.pointerType === "touch" &&
                        event.isPrimary &&
                        event.target instanceof Element &&
                        !event.target.closest("button, input, a")
                      ) {
                        swipeStart.current = {
                          pointerId: event.pointerId,
                          x: event.clientX,
                          y: event.clientY,
                          taskId: focused.item.id,
                        };
                      }
                    }}
                    onPointerUp={(event) => {
                      const start = swipeStart.current;
                      swipeStart.current = null;
                      if (
                        !start ||
                        event.pointerType !== "touch" ||
                        event.pointerId !== start.pointerId ||
                        start.taskId !== focused.item.id ||
                        !window.getSelection()?.isCollapsed
                      )
                        return;
                      const dx = event.clientX - start.x;
                      const dy = event.clientY - start.y;
                      if (
                        Math.abs(dx) <= 90 ||
                        Math.abs(dx) <= Math.abs(dy) * 1.5
                      )
                        return;
                      if (dx > 0) decide("confirm");
                      else nextTask();
                    }}
                    onPointerCancel={() => {
                      swipeStart.current = null;
                    }}
                    onPointerLeave={() => {
                      swipeStart.current = null;
                    }}
                  >
                    <MockTaskDetail
                      personName={person.user.name}
                      task={focused}
                      projectControl={projectPicker(focused)}
                      headerActions={
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs text-muted-foreground"
                            onClick={nextTask}
                          >
                            {t("voiceInbox.dismiss")}
                          </Button>
                          <Button
                            variant="success"
                            size="sm"
                            onClick={() => decide("confirm")}
                            title={focused.question}
                          >
                            {t("voiceInbox.approveAction")}
                          </Button>
                        </>
                      }
                      onClose={nextTask}
                      onChange={(item) =>
                        setTasks(
                          tasks.map((task) =>
                            task.item.id === item.id ? { ...task, item } : task,
                          ),
                        )
                      }
                    />
                  </div>
                </div>
              </ResizablePanel>
            </ResizablePanelGroup>
            <p className="sr-only">{t("voiceInbox.hint")}</p>
          </section>
        )}
        {view === "inbox" && !focused && (
          <section className="flex max-w-lg flex-col items-center px-6 text-center">
            <Check size={32} className="mb-6 text-success" />
            <h1 className="text-2xl font-medium">{t("voiceInbox.empty")}</h1>
            <p className="mt-4 text-sm text-muted-foreground">
              {t("voiceInbox.continues")}
            </p>
            <Button
              className="mt-6"
              variant="outline"
              onClick={() => navigate("board")}
            >
              {t("voiceInbox.board")}
            </Button>
          </section>
        )}
        {(view === "board" || view === "outside") && renderBoard()}
      </main>
      {showCompanion && (
        <footer className="mx-auto my-2 flex w-full max-w-4xl shrink-0 items-center gap-3 px-4 sm:px-6">
          <Orb small muted={muted} />
          <span className="sr-only" aria-live="polite">
            {notice ? t(notice) : ""}
          </span>
          <div className="min-w-0 flex-1">
            <NewCommentComposer
              compact
              agentRoute={isFocused ? "steer" : undefined}
              placeholder={t("voiceInbox.placeholder")}
              onSubmit={submit}
              trailingActions={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(
                    muted ? "voiceInbox.unmute" : "voiceInbox.mute",
                  )}
                  aria-pressed={!muted}
                  onClick={() => setMuted(!muted)}
                >
                  {muted ? <MicrophoneOff01 /> : <Microphone01 />}
                </Button>
              }
            />
          </div>
        </footer>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="fixed right-3 top-3 z-40 text-muted-foreground"
            aria-label={t("voiceInbox.controls")}
          >
            <DotsHorizontal size={16} />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="end"
          className="max-h-[80dvh] w-80 max-w-[calc(100vw-24px)] overflow-y-auto"
        >
          <nav
            aria-label={t(
              scenario ? "voiceInbox.reconstruction" : "voiceInbox.prototype",
            )}
            className="flex flex-wrap items-center gap-1"
          >
            <span className="mb-2 w-full text-xs text-muted-foreground">
              {t(
                scenario ? "voiceInbox.reconstruction" : "voiceInbox.prototype",
              )}
            </span>
            {VIEWS.map((tab) => (
              <Button
                key={tab.view}
                variant="tab"
                size="sm"
                aria-pressed={view === tab.view}
                onClick={() => navigate(tab.view)}
              >
                {t(tab.label)}
              </Button>
            ))}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("voiceInbox.reset")}
              onClick={reset}
            >
              <RefreshCw01 />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("voiceInbox.theme")}
              onClick={() => {
                document.documentElement.classList.toggle("dark", !dark);
                setDark(!dark);
              }}
            >
              {dark ? <Sun /> : <Moon01 />}
            </Button>
          </nav>
          {mockControls}
          {scenario && (
            <p className="mt-3 text-xs text-muted-foreground">
              {scenario.context}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        <DialogContent
          className="flex h-[85dvh] flex-col overflow-hidden sm:max-w-6xl"
          closeButtonClassName="hidden"
          aria-describedby={undefined}
        >
          <DialogHeader className="flex-row items-center justify-between">
            <DialogTitle className="flex items-center gap-3">
              <OrganizationMark name={orgName} branding={branding} />
              <span>
                {orgName} · {t("voiceInbox.details")}
              </span>
            </DialogTitle>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("voiceInbox.close")}
              onClick={() => setDetailId(null)}
            >
              <X />
            </Button>
          </DialogHeader>
          {detail && (
            <MockTaskDetail
              personName={person.user.name}
              task={detail}
              projectControl={projectPicker(detail)}
              onClose={() => setDetailId(null)}
              onChange={(item) =>
                setTasks(
                  tasks.map((task) =>
                    task.item.id === item.id ? { ...task, item } : task,
                  ),
                )
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
