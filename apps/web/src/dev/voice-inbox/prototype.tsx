import { useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
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
import { Input } from "@decocms/ui/components/input.tsx";
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
import { TaskMessage } from "@/layouts/task-board/task-message";
import { TaskAssigneeAvatar } from "@/components/task-assignee-avatar";
import { SuperAgentIcon } from "@/components/super-agent-icon";
import { useT, type TranslationKey } from "@/i18n/use-t";
import {
  CREATED_AT,
  initialTasks,
  needsPerson,
  PERSON,
  type MockTask,
} from "./data";
import "@/components/chat/voice/voice.css";
import "./prototype.css";
import { TaskTestContent } from "./task-test-content";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@decocms/ui/components/drawer.tsx";
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
}: {
  scenario?: Scenario;
  personName?: string;
  organization?: string;
  branding?: Branding;
}) {
  const t = useT();
  const [scope, setScope] = useState<"user" | "organization">("organization");
  const orgName = organization ?? "Demo";
  const [tasks, updateTasks] = useState(() =>
    scenario ? scenarioTasks(scenario) : initialTasks(),
  );
  const person = { ...PERSON, user: { name: personName ?? PERSON.user.name } };
  function setTasks(next: MockTask[] | ((current: MockTask[]) => MockTask[])) {
    const updated = typeof next === "function" ? next(tasks) : next;
    if (scenario) saveScenario(scenario, updated);
    updateTasks(updated);
  }
  const [view, setView] = useState<View>(() =>
    tasks.some(needsPerson) ? "inbox" : "welcome",
  );
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [testingId, setTestingId] = useState<string | null | undefined>(
    undefined,
  );
  const testButton = useRef<HTMLButtonElement>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [reply, setReply] = useState("");
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
  const hasTestingContent =
    !!focused &&
    !!(focused.pullRequest || focused.review?.testPlan || focused.review?.link);
  const testingOpen =
    isFocused &&
    hasTestingContent &&
    (testingId === focused.item.id || (testingId === undefined && !isMobile));
  function closeTesting() {
    setTestingId(null);
    testButton.current?.focus();
  }
  const showCompanion = view !== "welcome" && view !== "outside";
  function navigate(next: View) {
    setTestingId(undefined);
    document.getElementById("voice-inbox-main")?.scrollTo({ top: 0 });
    setView(next);
    setNotice(null);
  }
  function reset() {
    setTestingId(undefined);
    const restored = scenario ? scenarioTasks(scenario, false) : initialTasks();
    setTasks(restored);
    setFocusedId(null);
    setDetailId(null);
    setReply("");
    setNotice(null);
    setView(restored.some(needsPerson) ? "inbox" : "welcome");
  }
  function decide(kind: "confirm" | "steer", text?: string) {
    if (!focused) {
      setNotice("voiceInbox.noFocus");
      return;
    }
    setTestingId(undefined);
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
    setReply("");
    setFocusedId(null);
  }
  function nextTask() {
    setTestingId(undefined);
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
  function submit() {
    const text = reply.trim();
    if (!text) return;
    if (view !== "inbox") {
      setNotice("voiceInbox.noFocus");
      return;
    }
    if (/^(sim|aprova|aprovar|pode|segue)[.! ]*$/i.test(text))
      decide("confirm", text);
    else if (/^(depois|próxima|proxima)[.! ]*$/i.test(text)) {
      nextTask();
      setReply("");
    } else decide("steer", text);
  }
  function renderComments(task: MockTask) {
    return task.comments.map((comment) => (
      <TaskMessage
        key={comment.id}
        id={comment.id}
        author={
          comment.authorLabel ??
          (comment.author === "agent" ? "Super Agent" : person.user.name)
        }
        metadata={
          comment.eventLabel && (
            <span className="text-xs text-muted-foreground">
              {comment.eventLabel}
            </span>
          )
        }
        avatar={
          comment.authorLabel ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-muted text-xs">
              {comment.authorLabel.slice(0, 1)}
            </span>
          ) : comment.author === "agent" ? (
            <SuperAgentIcon size={20} />
          ) : (
            <TaskAssigneeAvatar assigneeId={PERSON.userId} assignee={person} />
          )
        }
        createdAt={CREATED_AT}
        body={comment.body}
      />
    ));
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
      <header className="relative flex h-20 shrink-0 items-center px-4 sm:px-7">
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
        <div className="absolute left-1/2 -translate-x-1/2">
          <InboxScope
            organization={orgName}
            branding={branding}
            scope={scope}
            onScopeChange={setScope}
          />
        </div>
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
          <section
            className={cn(
              "flex h-full min-h-0 w-full flex-col px-4 sm:px-6",
              testingOpen && !isMobile ? "max-w-7xl" : "max-w-4xl",
            )}
          >
            <div className="mb-3 flex shrink-0 items-center gap-3">
              <OrganizationMark name={orgName} branding={branding} />
              <div>
                <p className="text-sm font-medium">{orgName}</p>
                {focused.projectLabel && (
                  <p className="text-xs text-muted-foreground">
                    {focused.projectLabel}
                  </p>
                )}
              </div>
              <span className="ml-auto text-xs text-muted-foreground">
                {t(
                  pending.length === 1
                    ? "voiceInbox.oneRemaining"
                    : "voiceInbox.remaining",
                  { count: pending.length },
                )}
              </span>
            </div>
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
                  if (Math.abs(dx) <= 90 || Math.abs(dx) <= Math.abs(dy) * 1.5)
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
                <div
                  className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5"
                  tabIndex={0}
                  role="region"
                  aria-label={t("voiceInbox.details")}
                >
                  <div className="mb-4">
                    <p className="mb-2 text-xs text-muted-foreground">
                      {laneHeader(focused.item.status, t).label}
                    </p>
                    <div className="flex items-start justify-between gap-4">
                      <h1 className="text-xl font-medium tracking-tight">
                        {focused.item.title}
                      </h1>
                      {hasTestingContent && (
                        <Button
                          ref={testButton}
                          variant="default"
                          className="shrink-0 px-5"
                          aria-expanded={testingOpen}
                          aria-controls={
                            testingOpen && !isMobile
                              ? "voice-task-testing"
                              : undefined
                          }
                          onClick={() =>
                            setTestingId(testingOpen ? null : focused.item.id)
                          }
                        >
                          {t("voiceInbox.test")}
                        </Button>
                      )}
                    </div>
                    {focused.item.description && (
                      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                        {focused.item.description}
                      </p>
                    )}
                  </div>
                  <section className="mt-5 border-t pt-4 [&_time]:hidden">
                    <h2 className="mb-2 text-sm font-medium">
                      {t("voiceInbox.history")}
                    </h2>
                    <div className="divide-y">{renderComments(focused)}</div>
                  </section>
                </div>
                <div className="shrink-0 border-t bg-muted/30 p-4 sm:px-5">
                  <p className="mb-3 text-base font-medium">
                    {focused.question}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <Button variant="outline" onClick={nextTask}>
                      <ArrowLeft />
                      {t("voiceInbox.later")}
                    </Button>
                    <Button onClick={() => decide("confirm")}>
                      <Check />
                      {focused.confirmLabel ??
                        t(
                          focused.item.status === "customer_approval"
                            ? "voiceInbox.approve"
                            : "voiceInbox.confirm",
                        )}
                    </Button>
                  </div>
                </div>
              </div>
              {testingOpen && !isMobile && (
                <aside
                  id="voice-task-testing"
                  aria-label={t("voiceInbox.testTask")}
                  className="surface flex min-h-0 w-[38%] min-w-72 flex-col overflow-hidden"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.stopPropagation();
                      closeTesting();
                    }
                  }}
                >
                  <div className="flex shrink-0 items-center justify-between border-b p-4">
                    <h2 className="font-medium">{t("voiceInbox.testTask")}</h2>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("voiceInbox.close")}
                      onClick={closeTesting}
                    >
                      <X />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <TaskTestContent task={focused} />
                  </div>
                </aside>
              )}
            </div>
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
        <footer className="mx-auto my-3 w-full max-w-4xl shrink-0 px-4 sm:px-6">
          <div className="flex items-center gap-4">
            <Orb small muted={muted} />
            <div className="min-w-0 flex-1" aria-live="polite">
              <p className="text-sm leading-relaxed">
                {t(notice ?? "voiceInbox.listening")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {t(muted ? "voiceInbox.muted" : "voiceInbox.simulated")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t(muted ? "voiceInbox.unmute" : "voiceInbox.mute")}
              onClick={() => setMuted(!muted)}
            >
              {muted ? <MicrophoneOff01 /> : <Microphone01 />}
            </Button>
          </div>
          <form
            className="mt-2 flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              value={reply}
              onChange={(event) => setReply(event.target.value)}
              placeholder={t("voiceInbox.placeholder")}
              aria-label={t("voiceInbox.placeholder")}
            />
            <Button
              type="submit"
              size="icon"
              disabled={!reply.trim()}
              aria-label={t("voiceInbox.send")}
            >
              <ArrowUp />
            </Button>
          </form>
        </footer>
      )}
      {scenario && (
        <p className="shrink-0 px-5 pb-2 text-center text-xs text-muted-foreground">
          {scenario.context}
        </p>
      )}
      <nav
        aria-label={t(
          scenario ? "voiceInbox.reconstruction" : "voiceInbox.prototype",
        )}
        className="flex shrink-0 flex-wrap items-center justify-center gap-1 border-t px-3 py-1"
      >
        <span className="mr-4 text-xs text-muted-foreground">
          {t(scenario ? "voiceInbox.reconstruction" : "voiceInbox.prototype")}
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
      {isMobile && focused && (
        <Drawer
          open={testingOpen}
          onOpenChange={(open) => {
            if (!open) setTestingId(null);
          }}
        >
          <DrawerContent
            className="h-[85dvh]"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              testButton.current?.focus();
            }}
          >
            <DrawerHeader className="shrink-0 border-b py-3">
              <div className="flex items-center justify-between">
                <DrawerTitle>{t("voiceInbox.testTask")}</DrawerTitle>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("voiceInbox.close")}
                  onClick={closeTesting}
                >
                  <X />
                </Button>
              </div>
              <DrawerDescription>{focused.item.title}</DrawerDescription>
            </DrawerHeader>
            <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-8">
              <TaskTestContent task={focused} />
            </div>
          </DrawerContent>
        </Drawer>
      )}
      <Dialog
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setDetailId(null);
        }}
      >
        <DialogContent
          className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl"
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
            <>
              <TaskCard
                item={detail.item}
                assignee={person}
                assignedBy={person}
                onOpen={() => {
                  setDetailId(null);
                  setFocusedId(detail.item.id);
                  navigate(needsPerson(detail) ? "inbox" : "board");
                }}
              />
              <p className="text-sm leading-relaxed text-muted-foreground">
                {detail.item.description}
              </p>
              <div className="[&_time]:hidden">{renderComments(detail)}</div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
