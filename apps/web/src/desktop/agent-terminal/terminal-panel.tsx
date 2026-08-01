import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { AlertCircle, RefreshCw01, StopSquare } from "@untitledui/icons";
import { NativeAgentEmptyState } from "@/components/chat/native-agent-empty-state";
import { useChatTask } from "@/components/chat/context";
import type { LocalAgentOption } from "@/components/chat/pills/agent-options";
import { useT } from "@/i18n/use-t";
import { useNativeTerminalRuntime } from "./active-task-provider";
import type { TerminalControllerSnapshot } from "./terminal-controller";

function optionForHarness(
  harnessId: TerminalControllerSnapshot["harnessId"],
): LocalAgentOption | null {
  if (harnessId === "claude-code") return "claude-code-desktop";
  if (harnessId === "codex") return "codex-desktop";
  return null;
}

function NativeXterm({ readOnly }: { readOnly: boolean }) {
  const t = useT();
  const { controller } = useNativeTerminalRuntime();
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalLabel = t("chat.nativeTerminal.terminalLabel");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect -- xterm, ResizeObserver, and PTY subscriptions have explicit mount/dispose lifecycles
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const style = getComputedStyle(document.documentElement);
    const cssVar = (name: string) =>
      style.getPropertyValue(name).trim() || undefined;
    const terminal = new Terminal({
      allowTransparency: false,
      cursorBlink: !readOnly,
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

    const outputSubscription = controller.subscribeOutput((frame) => {
      if (frame.kind === "reset") terminal.reset();
      terminal.write(frame.data);
    });
    const inputSubscription = terminal.onData((data) => controller.input(data));
    const resizeSubscription = terminal.onResize(({ rows, cols }) =>
      controller.resize({ rows, cols }),
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
    const fit = () => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      fitAddon.fit();
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    if (!readOnly) terminal.focus();

    return () => {
      observer.disconnect();
      outputSubscription();
      stateSubscription();
      inputSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
    };
  }, [controller, readOnly, terminalLabel]);

  return (
    <div className="h-full min-h-0 bg-sidebar p-3">
      <div ref={containerRef} className="h-full" />
    </div>
  );
}

function statusKey(snapshot: TerminalControllerSnapshot) {
  if (snapshot.physicalState === "starting") {
    return "chat.nativeTerminal.starting" as const;
  }
  if (snapshot.physicalState === "exited") {
    return "chat.nativeTerminal.exited" as const;
  }
  if (snapshot.physicalState === "failed") {
    return "chat.nativeTerminal.failed" as const;
  }
  if (snapshot.connection === "reconnecting") {
    return "chat.nativeTerminal.reconnecting" as const;
  }
  if (
    snapshot.connection === "connecting" ||
    snapshot.connection === "disconnected"
  ) {
    return "chat.nativeTerminal.connecting" as const;
  }
  if (snapshot.logicalState === "working") {
    return "chat.nativeTerminal.working" as const;
  }
  if (snapshot.logicalState === "waiting_input") {
    return "chat.nativeTerminal.waitingForInput" as const;
  }
  return "chat.nativeTerminal.ready" as const;
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

function TerminalStatusBar() {
  const t = useT();
  const { snapshot, controller, isReadOnly, startAgent } =
    useNativeTerminalRuntime();
  const restartOption = optionForHarness(snapshot.harnessId);
  const canInterrupt =
    !isReadOnly && snapshot.hasSession && snapshot.physicalState === "running";

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar px-3 text-xs text-muted-foreground">
      <span
        className={cn(
          "size-2 rounded-full",
          snapshot.error
            ? "bg-destructive"
            : snapshot.logicalState === "working"
              ? "bg-success animate-pulse"
              : "bg-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{t(statusKey(snapshot))}</span>
      {snapshot.physicalState === "exited" && restartOption && !isReadOnly ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => void startAgent(restartOption).catch(() => {})}
        >
          <RefreshCw01 size={13} />
          {t("chat.nativeTerminal.restart")}
        </Button>
      ) : snapshot.retryable ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => {
            if (snapshot.physicalState === "failed" && restartOption) {
              void startAgent(restartOption).catch(() => {});
              return;
            }
            controller.retry();
          }}
        >
          <RefreshCw01 size={13} />
          {t("chat.nativeTerminal.retry")}
        </Button>
      ) : null}
      {canInterrupt && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={() => controller.interrupt()}
        >
          <StopSquare size={13} />
          {t("chat.nativeTerminal.interrupt")}
        </Button>
      )}
    </div>
  );
}

export function NativeAgentTerminalPanel() {
  const task = useChatTask();
  const { snapshot, isReadOnly } = useNativeTerminalRuntime();
  const shouldRenderTerminal =
    task.isThreadLocked ||
    snapshot.hasSession ||
    snapshot.physicalState === "starting";

  if (isReadOnly) return <Picker />;
  if (!shouldRenderTerminal) return <Picker />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <TerminalStatusBar />
      {snapshot.error && (
        <div
          role="alert"
          className="shrink-0 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          {snapshot.error.message}
        </div>
      )}
      <div className="min-h-0 flex-1">
        <NativeXterm readOnly={isReadOnly} />
      </div>
    </div>
  );
}
