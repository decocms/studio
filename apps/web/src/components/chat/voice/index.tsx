import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { Headphones, Mic, MicOff, MessageSquare, Square } from "lucide-react";
import { Button } from "@decocms/ui/components/button.tsx";
import { useProjectContext } from "@/sdk";
import { useOrgFlag } from "@/hooks/use-organization-settings";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile.ts";
import {
  resolveMobileSurface,
  type ChatLayoutState,
} from "@/hooks/use-chat-layout-state";
import { useT } from "@/i18n/use-t";
import { readLanguage } from "@/hooks/use-preferences";
import { useChatStream, useChatTask } from "../context";
import { ChatHighlight } from "../highlight";
import { QueueTray } from "../queue-tray";
import { VoiceSession } from "./session";
import "./voice.css";

let pendingStart:
  | { orgId: string; threadId: string; expires: number }
  | undefined;
const VoiceContext = createContext<{
  session: VoiceSession;
  enabled: boolean;
  start: () => void;
} | null>(null);

export function ChatVoiceProvider({
  children,
  layout,
}: PropsWithChildren<{ layout: ChatLayoutState }>) {
  const { org } = useProjectContext();
  const { taskId } = useChatTask();
  const isMobile = useIsMobile();
  const visible = isMobile
    ? resolveMobileSurface({
        visibility: layout,
        threadVisibilityExplicit: layout.threadVisibilityExplicit,
      }) === "chat"
    : layout.threadOpen || !layout.contentOpen;
  return (
    <VoiceProvider key={`${org.id}:${taskId ?? "new"}`} visible={visible}>
      {children}
    </VoiceProvider>
  );
}

function VoiceProvider({
  children,
  visible,
}: PropsWithChildren<{ visible: boolean }>) {
  const { org } = useProjectContext();
  const { taskId, createTask, activeTask } = useChatTask();
  const isDesktopApp = useIsDesktopApp();
  const flag = useOrgFlag("voice_mode");
  const enabled = flag && !isDesktopApp && !activeTask?.metadata?.read_only;
  const [session] = useState(
    () =>
      new VoiceSession(
        `/api/${encodeURIComponent(org.slug)}/threads/${encodeURIComponent(taskId ?? "")}/voice/sessions`,
        readLanguage() === "pt-BR" ? "pt" : "en",
      ),
  );
  useLayoutEffect(() => {
    if (!enabled || !visible) session.stop();
  }, [session, enabled, visible]);
  const [attach] = useState(() => (_node: HTMLDivElement | null) => {
    if (
      enabled &&
      taskId &&
      pendingStart?.orgId === org.id &&
      pendingStart.threadId === taskId
    ) {
      const shouldStart = pendingStart.expires > Date.now();
      pendingStart = undefined;
      if (shouldStart) void session.start();
    }
    const leave = () => session.stop();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      session.stop();
    };
  });
  const start = () => {
    if (!enabled) return;
    if (!taskId) {
      const threadId = createTask();
      pendingStart = { orgId: org.id, threadId, expires: Date.now() + 30_000 };
      return;
    }
    void session.start();
  };
  return (
    <VoiceContext value={{ session, enabled, start }}>
      <div className="contents" ref={attach}>
        {children}
      </div>
    </VoiceContext>
  );
}

export function ChatVoiceBindings({ children }: PropsWithChildren) {
  const context = useContext(VoiceContext);
  const stream = useChatStream();
  useLayoutEffect(() => {
    context?.session.updateBindings(stream, context.enabled);
  }, [context, stream]);
  return children;
}

export function useVoiceMode() {
  const context = useContext(VoiceContext);
  const snapshot = useSyncExternalStore(
    context?.session.subscribe ?? emptySubscribe,
    context?.session.getSnapshot ?? emptySnapshot,
  );
  return {
    active: snapshot?.phase !== undefined && snapshot.phase !== "idle",
    context,
    snapshot,
  };
}
const emptySubscribe = () => () => {};
const emptySnapshot = () => null;

export function VoiceModeToggle() {
  const t = useT();
  const { context } = useVoiceMode();
  if (!context?.enabled || !navigator.mediaDevices?.getUserMedia) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8 shrink-0"
      onClick={context.start}
      aria-label={t("chat.voice.start")}
      title={t("chat.voice.start")}
    >
      <Headphones size={18} />
    </Button>
  );
}

export function VoiceModePanel() {
  const t = useT();
  const { taskId } = useChatTask();
  const stream = useChatStream();
  const { context, snapshot, active } = useVoiceMode();
  if (!active || !context || !snapshot) return null;
  const { session } = context;
  const status = snapshot.error
    ? t(`chat.voice.${snapshot.error}`)
    : snapshot.muted
      ? t("chat.voice.muted")
      : t(`chat.voice.${snapshot.phase}`);
  return (
    <section
      aria-label={t("chat.voice.title")}
      className="absolute inset-0 flex min-h-0 flex-col bg-background"
    >
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-7 overflow-y-auto px-6 py-8">
        <div
          className="studio-voice-orb"
          data-phase={snapshot.phase}
          data-muted={snapshot.muted}
          aria-hidden="true"
          style={{ transform: `scale(${1 + snapshot.level * 0.22})` }}
        />
        <p
          role="status"
          className="max-w-sm text-center text-sm text-muted-foreground"
        >
          {status}
        </p>
        {snapshot.transcript && (
          <p
            className="line-clamp-3 max-w-sm text-center text-sm"
            data-voice-transcript
          >
            {snapshot.transcript}
          </p>
        )}
        {snapshot.response && (
          <p
            className="line-clamp-3 max-w-sm text-center text-sm text-muted-foreground"
            data-voice-response
          >
            {snapshot.response}
          </p>
        )}
        {snapshot.working && (
          <p className="text-center text-xs text-muted-foreground">
            {t("chat.voice.backgroundWork")}
          </p>
        )}
        {snapshot.phase === "error" && (
          <Button variant="outline" onClick={context.start}>
            {t("chat.voice.retry")}
          </Button>
        )}
      </div>
      <div className="max-h-[55%] shrink-0 overflow-y-auto px-3">
        <ChatHighlight inline voiceMode />
        {taskId && <QueueTray taskId={taskId} />}
      </div>
      <div className="flex shrink-0 items-center justify-center gap-3 px-4 py-6">
        <Button
          variant="outline"
          size="icon"
          disabled={
            snapshot.phase === "connecting" || snapshot.phase === "error"
          }
          aria-label={t(
            snapshot.muted ? "chat.voice.unmute" : "chat.voice.mute",
          )}
          title={t(snapshot.muted ? "chat.voice.unmute" : "chat.voice.mute")}
          aria-pressed={snapshot.muted}
          onClick={session.toggleMute}
        >
          {snapshot.muted ? <MicOff size={18} /> : <Mic size={18} />}
        </Button>
        <Button variant="outline" onClick={session.stop}>
          <MessageSquare size={16} />
          {t("chat.voice.backToChat")}
        </Button>
        {(stream.isStreaming || stream.isRunInProgress) && (
          <Button
            variant="outline"
            size="icon"
            aria-label={t("chat.voice.stopWork")}
            title={t("chat.voice.stopWork")}
            onClick={stream.stop}
          >
            <Square size={16} />
          </Button>
        )}
      </div>
    </section>
  );
}
