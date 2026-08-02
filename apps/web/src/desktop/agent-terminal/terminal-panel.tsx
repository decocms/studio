import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AlertCircle } from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { NativeAgentEmptyState } from "@/components/chat/native-agent-empty-state";
import { localHarnessBrand } from "@/components/chat/agent-icons";
import { useChatTask } from "@/components/chat/context";
import { GridLoader } from "@/components/grid-loader";
import { useT } from "@/i18n/use-t";
import { useNativeTerminalRuntime } from "./active-task-provider";
import {
  createTerminalParserCapabilityQueryAuthority,
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers,
} from "./terminal-capability-replies";
import type { TerminalReplayFrame } from "./protocol";

const TERMINAL_REVEAL_FALLBACK_MS = 1_750;

export function hasVisibleTerminalContent(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  const firstLine = Math.max(0, buffer.viewportY);
  const lastLine = Math.min(buffer.length, firstLine + terminal.rows);

  for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex++) {
    if (buffer.getLine(lineIndex)?.translateToString(true).trim()) return true;
  }
  return false;
}

export function shouldRevealTerminal(
  receivedOutput: boolean,
  hasVisibleContent: boolean,
  fallbackElapsed: boolean,
): boolean {
  return receivedOutput && (hasVisibleContent || fallbackElapsed);
}

function NativeXterm({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const { controller, snapshot } = useNativeTerminalRuntime();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isTerminalRevealed, setIsTerminalRevealed] = useState(false);
  const terminalLabel = t("chat.nativeTerminal.terminalLabel");
  const brand = localHarnessBrand(snapshot.harnessId);
  const AgentIcon = brand?.Icon;
  const agentLabel = brand
    ? t(brand.labelKey)
    : t("chat.nativeTerminal.agentLabel");
  const unavailableBeforeOutput =
    snapshot.physicalState === "failed" ||
    snapshot.physicalState === "exited" ||
    (snapshot.error !== null && !snapshot.retryable);
  const loadingLabel = t(
    snapshot.connection === "reconnecting"
      ? "chat.nativeTerminal.reconnectingAgent"
      : "chat.nativeTerminal.startingAgent",
    { agent: agentLabel },
  );
  const unavailableLabel =
    snapshot.error?.message ?? t("chat.nativeTerminal.exitedBeforeReady");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- xterm, ResizeObserver, and PTY subscriptions have explicit mount/dispose lifecycles
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    setIsTerminalRevealed(false);

    const style = getComputedStyle(document.documentElement);
    const cssVar = (name: string) =>
      style.getPropertyValue(name).trim() || undefined;
    const terminal = new Terminal({
      allowProposedApi: true,
      allowTransparency: false,
      cursorBlink: false,
      disableStdin: readOnly,
      fontFamily:
        cssVar("--font-mono") ||
        "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: {
        background:
          cssVar("--sidebar") ||
          cssVar("--card") ||
          cssVar("--background") ||
          "#1e1e1e",
        cursor: cssVar("--foreground") || "#d4d4d4",
        foreground: cssVar("--foreground") || "#d4d4d4",
        selectionBackground: cssVar("--accent"),
        selectionForeground: cssVar("--accent-foreground"),
        black: cssVar("--muted"),
        red: cssVar("--destructive"),
        green: cssVar("--success"),
        yellow: cssVar("--warning"),
        blue: cssVar("--chart-1"),
        magenta: cssVar("--chart-3"),
        cyan: cssVar("--chart-5"),
        white: cssVar("--foreground"),
        brightBlack: cssVar("--muted-foreground"),
        brightRed: cssVar("--destructive"),
        brightGreen: cssVar("--success"),
        brightYellow: cssVar("--warning"),
        brightBlue: cssVar("--chart-1"),
        brightMagenta: cssVar("--chart-3"),
        brightCyan: cssVar("--chart-5"),
        brightWhite: cssVar("--foreground"),
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    terminal.textarea?.setAttribute("aria-label", terminalLabel);

    const resizeSubscription = terminal.onResize(({ rows, cols }) =>
      controller.resize({ rows, cols }),
    );
    const fit = () => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fitAddon.fit();
    };
    fit();

    let disposed = false;
    let writing = false;
    let repliesAllowed = false;
    let receivedOutput = false;
    let revealed = false;
    let revealFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const outputQueue: Array<{
      frame: TerminalReplayFrame;
      acknowledgeCapabilityReplies: () => void;
    }> = [];
    const parserCapabilityQueryAuthority =
      createTerminalParserCapabilityQueryAuthority();
    const capabilityHandlers = installTerminalCapabilityReplyHandlers({
      terminal,
      parser: terminal.parser,
      sendInput: (data) => controller.input(data),
      takeReplyAuthority: parserCapabilityQueryAuthority.takeReplyAuthority,
    });
    const pixelSizeResponder = createTerminalPixelSizeQueryResponder(
      terminal,
      (data) => controller.input(data),
    );
    const cancelRevealFallback = () => {
      if (revealFallbackTimer === null) return;
      clearTimeout(revealFallbackTimer);
      revealFallbackTimer = null;
    };
    const terminalUnavailable = () => {
      const current = controller.snapshot.get();
      return (
        current.physicalState === "failed" ||
        current.physicalState === "exited" ||
        (current.error !== null && !current.retryable)
      );
    };
    const revealTerminal = (fallbackElapsed = false) => {
      const visibleContent = hasVisibleTerminalContent(terminal);
      if (
        disposed ||
        revealed ||
        !shouldRevealTerminal(
          receivedOutput,
          visibleContent,
          fallbackElapsed,
        ) ||
        (fallbackElapsed && terminalUnavailable())
      ) {
        return;
      }
      revealed = true;
      cancelRevealFallback();
      terminal.options.cursorBlink = !readOnly;
      setIsTerminalRevealed(true);
      if (!readOnly) terminal.focus();
    };
    const scheduleRevealFallback = () => {
      if (disposed || revealed || revealFallbackTimer !== null) return;
      revealFallbackTimer = setTimeout(() => {
        revealFallbackTimer = null;
        revealTerminal(true);
      }, TERMINAL_REVEAL_FALLBACK_MS);
    };
    const renderSubscription = terminal.onRender(() => revealTerminal());
    const inputSubscription = terminal.onData((data) => {
      // xterm can synthesize protocol replies through onData while parsing.
      // A query may begin in replay and finish in a live frame, so the current
      // frame alone cannot authorize the reply. The byte scanner carries the
      // authority across that parser boundary and consumes it by reply family.
      if (readOnly) return;
      if (writing) {
        const nativeReplyAuthority =
          parserCapabilityQueryAuthority.takeNativeReplyAuthority(data);
        if (nativeReplyAuthority === false) return;
        if (nativeReplyAuthority === null && !repliesAllowed) return;
      }
      controller.input(data);
    });
    const drainOutput = () => {
      if (disposed || writing) return;
      const next = outputQueue.shift();
      if (!next) return;
      const { frame, acknowledgeCapabilityReplies } = next;
      if (frame.kind === "reset") {
        cancelRevealFallback();
        receivedOutput = false;
        revealed = false;
        terminal.options.cursorBlink = false;
        terminal.blur();
        setIsTerminalRevealed(false);
        terminal.reset();
        parserCapabilityQueryAuthority.reset();
        pixelSizeResponder.reset();
      }
      if (frame.data.byteLength === 0) {
        acknowledgeCapabilityReplies();
        drainOutput();
        return;
      }
      writing = true;
      receivedOutput = true;
      repliesAllowed = !readOnly && frame.allowCapabilityReplies;
      parserCapabilityQueryAuthority.observe(frame.data, repliesAllowed);
      pixelSizeResponder.observe(frame.data, repliesAllowed);
      terminal.write(frame.data, () => {
        if (!disposed) {
          acknowledgeCapabilityReplies();
          revealTerminal();
          scheduleRevealFallback();
        }
        repliesAllowed = false;
        writing = false;
        drainOutput();
      });
    };
    const outputSubscription = controller.subscribeOutput(
      (frame, acknowledgeCapabilityReplies) => {
        outputQueue.push({ frame, acknowledgeCapabilityReplies });
        drainOutput();
      },
    );
    const syncInputState = () => {
      const snapshot = controller.snapshot.get();
      terminal.options.disableStdin =
        readOnly ||
        snapshot.connection !== "connected" ||
        !snapshot.hasSession ||
        snapshot.physicalState !== "running";
    };
    const stateSubscription = controller.snapshot.subscribe(syncInputState);
    syncInputState();
    const observer = new ResizeObserver(fit);
    observer.observe(element);

    return () => {
      disposed = true;
      cancelRevealFallback();
      repliesAllowed = false;
      outputQueue.length = 0;
      observer.disconnect();
      outputSubscription();
      stateSubscription();
      capabilityHandlers.dispose();
      renderSubscription.dispose();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
    };
  }, [controller, readOnly, terminalLabel]);

  return (
    <div
      className="relative h-full min-h-0 bg-sidebar p-3"
      aria-busy={!isTerminalRevealed && !unavailableBeforeOutput}
    >
      <div ref={containerRef} className="h-full" />
      <div
        aria-hidden={isTerminalRevealed}
        className={cn(
          "absolute inset-0 z-10 flex items-center justify-center bg-sidebar transition-opacity duration-200 motion-reduce:transition-none",
          isTerminalRevealed ? "pointer-events-none opacity-0" : "opacity-100",
        )}
      >
        {unavailableBeforeOutput ? (
          <div
            role="alert"
            className="flex max-w-sm flex-col items-center gap-3 px-6 text-center"
          >
            <AlertCircle size={24} className="text-destructive" />
            <p className="text-sm text-muted-foreground">{unavailableLabel}</p>
          </div>
        ) : (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2.5 rounded-full border border-border bg-background px-3.5 py-2 shadow-sm animate-in fade-in duration-200 motion-reduce:animate-none motion-reduce:[&_*]:animate-none"
          >
            {AgentIcon && (
              <span className="flex size-5 items-center justify-center text-foreground">
                <AgentIcon size={15} />
              </span>
            )}
            <GridLoader />
            <span className="text-sm font-medium text-foreground">
              {loadingLabel}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function Picker() {
  const { snapshot, startAgent, isReadOnly } = useNativeTerminalRuntime();
  const t = useT();

  if (isReadOnly) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle size={28} className="text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t("chat.nativeTerminal.readOnlyTitle")}
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          {t("chat.nativeTerminal.readOnly")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto py-8">
      {snapshot.error && (
        <div
          role="alert"
          className="mx-4 max-w-lg rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          {snapshot.error.message}
        </div>
      )}
      <NativeAgentEmptyState
        onSelect={(option) => {
          void startAgent(option).catch(() => {});
        }}
      />
    </div>
  );
}

export function NativeAgentTerminalPanel() {
  const task = useChatTask();
  const { controller, snapshot, isReadOnly } = useNativeTerminalRuntime();
  const shouldRenderTerminal =
    task.isThreadLocked ||
    snapshot.hasSession ||
    snapshot.physicalState === "starting";

  if (isReadOnly) return <Picker />;
  if (!shouldRenderTerminal) return <Picker />;

  return <NativeXterm key={controller.threadId} readOnly={isReadOnly} />;
}
