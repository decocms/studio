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
import type {
  TerminalControllerOutputFrame,
  TerminalControllerSnapshot,
} from "./terminal-controller";

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

export function shouldForwardTerminalData(
  nativeReplyAuthority: boolean | null,
): boolean {
  return nativeReplyAuthority !== false;
}

export type TerminalPulsePhase = "starting" | "reconnecting" | "waiting-output";

export function terminalPulsePhase(
  connection: TerminalControllerSnapshot["connection"],
  physicalState: TerminalControllerSnapshot["physicalState"],
): TerminalPulsePhase {
  if (
    connection === "reconnecting" ||
    (connection !== "connected" && physicalState === "running")
  ) {
    return "reconnecting";
  }
  if (connection === "connected" && physicalState === "running") {
    return "waiting-output";
  }
  return "starting";
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
  const pulsePhase = terminalPulsePhase(
    snapshot.connection,
    snapshot.physicalState,
  );
  const unavailableBeforeOutput =
    snapshot.physicalState === "failed" ||
    snapshot.physicalState === "exited" ||
    (snapshot.error !== null && !snapshot.retryable);
  const loadingLabel = t(
    pulsePhase === "reconnecting"
      ? "chat.nativeTerminal.reconnectingAgent"
      : pulsePhase === "waiting-output"
        ? "chat.nativeTerminal.waitingForAgentOutput"
        : "chat.nativeTerminal.startingAgent",
    { agent: agentLabel },
  );
  const pulseContext = t(
    pulsePhase === "reconnecting"
      ? "chat.nativeTerminal.pulseReconnecting"
      : pulsePhase === "waiting-output"
        ? "chat.nativeTerminal.pulseConnected"
        : "chat.nativeTerminal.pulseInitializing",
  );
  const unavailableLabel =
    snapshot.error?.message ?? t("chat.nativeTerminal.exitedBeforeReady");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- xterm, ResizeObserver, and PTY subscriptions have explicit mount/dispose lifecycles
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    setIsTerminalRevealed(false);

    const cssVar = (name: string) =>
      getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim() || undefined;
    const colorCanvas = document.createElement("canvas");
    colorCanvas.width = 1;
    colorCanvas.height = 1;
    const colorContext = colorCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    const terminalColor = (names: string[], fallback: string): string => {
      const raw = names.map(cssVar).find(Boolean) ?? fallback;
      if (!colorContext) return raw;

      colorContext.clearRect(0, 0, 1, 1);
      colorContext.fillStyle = fallback;
      colorContext.fillStyle = raw;
      colorContext.fillRect(0, 0, 1, 1);
      const pixel = colorContext.getImageData(0, 0, 1, 1).data;
      const red = pixel[0] ?? 0;
      const green = pixel[1] ?? 0;
      const blue = pixel[2] ?? 0;
      const alpha = pixel[3] ?? 255;
      return alpha === 255
        ? `rgb(${red}, ${green}, ${blue})`
        : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    };
    const createTerminalTheme = () => ({
      background: terminalColor(
        ["--background", "--card", "--sidebar"],
        "#1e1e1e",
      ),
      cursor: terminalColor(["--foreground"], "#d4d4d4"),
      foreground: terminalColor(["--foreground"], "#d4d4d4"),
      selectionBackground: terminalColor(
        ["--accent"],
        "rgba(255, 255, 255, 0.2)",
      ),
      selectionForeground: terminalColor(
        ["--accent-foreground", "--foreground"],
        "#d4d4d4",
      ),
      black: terminalColor(["--muted"], "#666666"),
      red: terminalColor(["--destructive"], "#ef4444"),
      green: terminalColor(["--success"], "#22c55e"),
      yellow: terminalColor(["--warning"], "#eab308"),
      blue: terminalColor(["--chart-1"], "#3b82f6"),
      magenta: terminalColor(["--chart-3"], "#d946ef"),
      cyan: terminalColor(["--chart-5"], "#06b6d4"),
      white: terminalColor(["--foreground"], "#d4d4d4"),
      brightBlack: terminalColor(["--muted-foreground"], "#737373"),
      brightRed: terminalColor(["--destructive"], "#ef4444"),
      brightGreen: terminalColor(["--success"], "#22c55e"),
      brightYellow: terminalColor(["--warning"], "#eab308"),
      brightBlue: terminalColor(["--chart-1"], "#3b82f6"),
      brightMagenta: terminalColor(["--chart-3"], "#d946ef"),
      brightCyan: terminalColor(["--chart-5"], "#06b6d4"),
      brightWhite: terminalColor(["--foreground"], "#d4d4d4"),
    });
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
      theme: createTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(element);
    terminal.textarea?.setAttribute("aria-label", terminalLabel);
    const syncTerminalTheme = () => {
      const theme = createTerminalTheme();
      terminal.options.theme = theme;
      const viewport =
        terminal.element?.querySelector<HTMLElement>(".xterm-viewport");
      if (viewport) viewport.style.backgroundColor = theme.background;
    };
    syncTerminalTheme();
    const themeObserver = new MutationObserver(syncTerminalTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "style"],
    });

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
      frame: TerminalControllerOutputFrame;
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
        if (!shouldForwardTerminalData(nativeReplyAuthority)) return;
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
      if (frame.restorePendingCapabilityReplies) {
        parserCapabilityQueryAuthority.restorePendingReplyAuthority();
        pixelSizeResponder.restorePendingReplyAuthority();
      }
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
      themeObserver.disconnect();
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
      className="relative h-full min-h-0 bg-background p-3"
      aria-busy={!isTerminalRevealed && !unavailableBeforeOutput}
    >
      <div ref={containerRef} className="h-full bg-background" />
      <div
        aria-hidden={isTerminalRevealed}
        className={cn(
          "absolute inset-0 z-10 flex items-center justify-center bg-background transition-opacity duration-200 motion-reduce:transition-none",
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
            className="relative flex h-full w-full flex-col overflow-hidden bg-background px-5 py-5 font-mono animate-in fade-in duration-200 motion-reduce:animate-none motion-reduce:[&_*]:animate-none"
          >
            <div
              aria-hidden="true"
              className="flex items-center justify-between gap-4 text-[10px] text-muted-foreground"
            >
              <span className="flex min-w-0 items-center gap-2">
                {AgentIcon && (
                  <span className="flex size-4 shrink-0 items-center justify-center text-foreground">
                    <AgentIcon size={13} />
                  </span>
                )}
                <span className="truncate">{agentLabel}</span>
              </span>
              <span className="shrink-0">{pulseContext}</span>
            </div>

            <div className="flex flex-1 flex-col justify-center pb-6">
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <span aria-hidden="true" className="text-success">
                  ›
                </span>
                <span className="lowercase">{loadingLabel}</span>
                <span
                  aria-hidden="true"
                  className="inline-block h-4 w-1.5 animate-pulse bg-foreground motion-reduce:animate-none"
                />
              </div>
              <p className="ml-4 mt-2 text-[10px] text-muted-foreground">
                {t("chat.nativeTerminal.waitingForTerminalDraw")}
              </p>
            </div>

            <span
              aria-hidden="true"
              className="absolute bottom-6 right-6 opacity-60"
            >
              <GridLoader />
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
