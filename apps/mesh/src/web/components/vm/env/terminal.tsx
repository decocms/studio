import { useRef, useEffect } from "react";
import { cn } from "@deco/ui/lib/utils.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useVmChunkHandler, useVmEvents } from "../hooks/use-vm-events";

interface VmTerminalProps {
  /**
   * Log source this terminal renders ("setup", "daemon", or a script name
   * like "dev"). The terminal pulls the replay buffer at mount and subscribes
   * to live chunks for this source. Self-contained — no parent-side routing.
   */
  source: string;
  onReady?: (terminal: Terminal) => void;
  onSelectionChange?: (hasSelection: boolean, getText: () => string) => void;
  className?: string;
}

export function VmTerminal({
  source,
  onReady,
  onSelectionChange,
  className,
}: VmTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  const vmEvents = useVmEvents();
  // Stable ref so the chunk handler (registered once on mount) always sees
  // the current source; no dep churn on prop changes.
  const sourceRef = useRef(source);
  sourceRef.current = source;

  useVmChunkHandler((chunkSource, data) => {
    if (chunkSource !== sourceRef.current) return;
    terminalRef.current?.write(data);
  });

  // oxlint-disable-next-line ban-use-effect/ban-use-effect — xterm.js lifecycle: create on mount, dispose on unmount
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const style = getComputedStyle(document.documentElement);
    const cssVar = (name: string) =>
      style.getPropertyValue(name).trim() || undefined;

    const terminal = new Terminal({
      allowTransparency: false,
      fontFamily:
        cssVar("--font-mono") ||
        "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12.5,
      lineHeight: 1.5,
      scrollback: 5000,
      cursorBlink: false,
      disableStdin: true,
      theme: {
        background:
          cssVar("--sidebar") ||
          cssVar("--card") ||
          cssVar("--background") ||
          "#1e1e1e",
        cursor: "transparent",
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

    terminal.open(el);
    fitAddon.fit();
    // Replay anything the buffer has accumulated for this source — covers
    // chunks that arrived before the tab mounted (e.g. clone output that
    // streamed during the "creating" status phase).
    const replay = vmEvents.getBuffer(source);
    if (replay) {
      terminal.write(replay);
    }
    terminalRef.current = terminal;
    onReady?.(terminal);

    const selectionDisposable = terminal.onSelectionChange(() => {
      const has = !!terminal.getSelection();
      onSelectionChangeRef.current?.(has, () => terminal.getSelection());
    });

    const observer = new ResizeObserver(() => {
      fitAddon.fit();
    });
    observer.observe(el);

    return () => {
      selectionDisposable.dispose();
      observer.disconnect();
      terminalRef.current = null;
      terminal.dispose();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps — mount-only: source/vmEvents/onReady are consumed once during terminal setup
  }, []);

  return (
    <div
      ref={containerRef}
      className={cn(
        "overflow-hidden bg-sidebar px-4 py-3 [&_.xterm]:h-full [&_.xterm-screen]:min-h-full [&_.xterm-viewport]:overscroll-contain",
        className,
      )}
    />
  );
}
