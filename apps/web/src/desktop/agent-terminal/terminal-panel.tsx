import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { AlertCircle } from "@untitledui/icons";
import { NativeAgentEmptyState } from "@/components/chat/native-agent-empty-state";
import { localHarnessBrand } from "@/components/chat/agent-icons";
import { useChatTask } from "@/components/chat/context";
import { ChatSidePanel } from "@/components/chat/side-panel-chat";
import { GridLoader } from "@/components/grid-loader";
import { useVirtualMCP } from "@/sdk";
import { resolveFastPreview } from "@/sdk/fast-preview";
import { useT } from "@/i18n/use-t";
import { useNativeTerminalRuntime } from "./active-task-provider";
import {
  createTerminalParserCapabilityQueryAuthority,
  createTerminalPixelSizeQueryResponder,
  installTerminalCapabilityReplyHandlers,
} from "./terminal-capability-replies";
import { toTerminalHarnessId } from "./protocol";
import type { TerminalControllerSnapshot } from "./terminal-controller";
import { TerminalOutputScheduler } from "./terminal-output-scheduler";
import { attachTerminalTuiWheelNormalization } from "./terminal-tui-wheel";

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

type NativeTerminalPanelSurface = "picker" | "terminal" | "unsupported";

export function nativeTerminalPanelSurface({
  isThreadLocked,
  lockedHarness,
  hasSession,
  physicalState,
}: {
  isThreadLocked: boolean;
  lockedHarness: string | null;
  hasSession: boolean;
  physicalState: TerminalControllerSnapshot["physicalState"];
}): NativeTerminalPanelSurface {
  if (isThreadLocked && !toTerminalHarnessId(lockedHarness)) {
    return "unsupported";
  }
  if (isThreadLocked || hasSession || physicalState === "starting") {
    return "terminal";
  }
  return "picker";
}

const OPENABLE_TERMINAL_PROTOCOLS = new Set([
  "http:",
  "https:",
  "vscode:",
  "cursor:",
]);

export function isOpenableTerminalLink(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (!OPENABLE_TERMINAL_PROTOCOLS.has(url.protocol)) return false;
    if (url.protocol !== "http:") return true;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
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
    const activateTerminalLink = (_event: MouseEvent, uri: string) => {
      if (!isOpenableTerminalLink(uri)) return;
      window.open(uri, "_blank", "noopener,noreferrer");
    };
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
      linkHandler: {
        activate: activateTerminalLink,
        allowNonHttpProtocols: true,
      },
      fastScrollSensitivity: 5,
      scrollSensitivity: 1.15,
      scrollback: 10_000,
      theme: createTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon(activateTerminalLink);
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(element);
    attachTerminalTuiWheelNormalization(terminal);
    try {
      const webglAddon = new WebglAddon();
      terminal.loadAddon(webglAddon);
      webglAddon.onContextLoss(() => webglAddon.dispose());
    } catch {
      // xterm keeps its DOM renderer when WebGL2 is unavailable.
    }
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
    let receivedOutput = false;
    let revealed = false;
    let restoreUntilSeq = 0;
    let waitingForRestorePaint = false;
    let restorePaintFrame: number | null = null;
    let revealFallbackTimer: ReturnType<typeof setTimeout> | null = null;
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
    const cancelRestorePaint = () => {
      if (restorePaintFrame === null) return;
      cancelAnimationFrame(restorePaintFrame);
      restorePaintFrame = null;
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
      if (
        disposed ||
        revealed ||
        restoreUntilSeq > 0 ||
        waitingForRestorePaint
      ) {
        return;
      }
      const visibleContent = hasVisibleTerminalContent(terminal);
      if (
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
    const revealAfterRestorePaint = () => {
      cancelRestorePaint();
      waitingForRestorePaint = true;
      terminal.scrollToBottom();
      terminal.refresh(0, terminal.rows - 1);
      restorePaintFrame = requestAnimationFrame(() => {
        restorePaintFrame = requestAnimationFrame(() => {
          restorePaintFrame = null;
          waitingForRestorePaint = false;
          revealTerminal();
          scheduleRevealFallback();
        });
      });
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
    const outputScheduler = new TerminalOutputScheduler({
      write: (data, onParsed) => terminal.write(data, onParsed),
      onWriteStateChange: (nextWriting) => {
        writing = nextWriting;
      },
      onFrameStart: (frame) => {
        if (
          frame.restoreUntilSeq !== null &&
          frame.restoreUntilSeq > restoreUntilSeq
        ) {
          restoreUntilSeq = frame.restoreUntilSeq;
          waitingForRestorePaint = false;
          cancelRestorePaint();
        }
        if (frame.kind === "reset") {
          cancelRevealFallback();
          cancelRestorePaint();
          restoreUntilSeq = frame.restoreUntilSeq ?? 0;
          receivedOutput = false;
          revealed = false;
          waitingForRestorePaint = false;
          terminal.options.cursorBlink = false;
          terminal.blur();
          setIsTerminalRevealed(false);
          terminal.reset();
          parserCapabilityQueryAuthority.reset();
          pixelSizeResponder.reset();
        }
        if (frame.data.byteLength === 0) return;
        receivedOutput = true;
        const allowReplies = !readOnly && frame.allowCapabilityReplies;
        parserCapabilityQueryAuthority.observe(frame.data, allowReplies);
        pixelSizeResponder.observe(frame.data, allowReplies);
        if (frame.restorePendingCapabilityReplies) {
          parserCapabilityQueryAuthority.restorePendingReplyAuthority();
          pixelSizeResponder.restorePendingReplyAuthority();
        }
      },
      onFrameParsed: (frame) => {
        if (disposed) return;
        controller.acknowledgeOutput(frame.seq);
        if (restoreUntilSeq > 0 && frame.seq >= restoreUntilSeq) {
          restoreUntilSeq = 0;
          revealAfterRestorePaint();
          return;
        }
        revealTerminal();
        scheduleRevealFallback();
      },
      onOverflow: () => controller.restartOutputReplay(),
    });
    const outputSubscription = controller.subscribeOutput(
      (frame, acknowledgeCapabilityReplies) => {
        outputScheduler.enqueue(frame, acknowledgeCapabilityReplies);
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
      cancelRestorePaint();
      outputScheduler.dispose();
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
      {!isTerminalRevealed && !unavailableBeforeOutput && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
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
                <span className="shimmer lowercase">{loadingLabel}</span>
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
        </div>
      )}
    </div>
  );
}

function Picker() {
  const { startAgent, isReadOnly } = useNativeTerminalRuntime();
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
    <div className="flex h-full flex-col items-center justify-center gap-5 overflow-y-auto px-2 py-8">
      <NativeAgentEmptyState
        onSelect={(option) => {
          void startAgent(option).catch(() => {});
        }}
      />
    </div>
  );
}

function UnsupportedHarnessState() {
  const t = useT();

  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <AlertCircle size={28} className="text-muted-foreground" />
      <p className="text-sm font-medium text-foreground">
        {t("chat.nativeTerminal.unsupportedHarnessTitle")}
      </p>
      <p className="max-w-sm text-sm text-muted-foreground">
        {t("chat.nativeTerminal.unsupportedHarness")}
      </p>
    </div>
  );
}

export function NativeAgentTerminalPanel() {
  const task = useChatTask();
  const vm = useVirtualMCP(task.virtualMcpId);
  const fastPreviewActive = resolveFastPreview(
    vm?.metadata,
    task.activeTask?.metadata,
  ).active;
  const { controller, snapshot, isReadOnly } = useNativeTerminalRuntime();
  const surface = nativeTerminalPanelSurface({
    isThreadLocked: task.isThreadLocked,
    lockedHarness: task.lockedHarness,
    hasSession: snapshot.hasSession,
    physicalState: snapshot.physicalState,
  });

  if (surface === "unsupported") return <UnsupportedHarnessState />;
  if (isReadOnly) return <Picker />;
  // Web chat surface (empty state + session card); its stamped thread lands on the picker.
  if (fastPreviewActive) return <ChatSidePanel />;
  if (surface === "picker") return <Picker />;

  return <NativeXterm key={controller.threadId} readOnly={isReadOnly} />;
}
