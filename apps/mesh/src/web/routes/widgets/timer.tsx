import { useState } from "react";
import { useWidget } from "./use-widget.ts";

type TimerArgs = { duration?: number; label?: string };

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function Timer() {
  const { args } = useWidget<TimerArgs>();
  const [remaining, setRemaining] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [intervalId, setIntervalId] = useState<ReturnType<
    typeof setInterval
  > | null>(null);

  if (!args) return null;

  const { duration = 60, label = "Timer" } = args;
  const display = remaining !== null ? remaining : duration;

  function start() {
    if (running) return;
    const start = remaining !== null ? remaining : duration;
    setRemaining(start);
    setRunning(true);
    const id = setInterval(() => {
      setRemaining((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(id);
          setRunning(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    setIntervalId(id);
  }

  function pause() {
    if (intervalId) clearInterval(intervalId);
    setRunning(false);
    setIntervalId(null);
  }

  function reset() {
    if (intervalId) clearInterval(intervalId);
    setRunning(false);
    setIntervalId(null);
    setRemaining(null);
  }

  return (
    <div className="p-4 font-sans text-center">
      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
        {label}
      </div>
      <div className="text-5xl font-bold text-foreground tabular-nums mb-4 font-mono">
        {formatTime(display)}
      </div>
      <div className="flex gap-2 justify-center">
        {!running ? (
          <button
            type="button"
            onClick={start}
            disabled={display === 0}
            className="px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {remaining === null ? "Start" : "Resume"}
          </button>
        ) : (
          <button
            type="button"
            onClick={pause}
            className="px-4 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm font-medium hover:bg-accent transition-colors"
          >
            Pause
          </button>
        )}
        <button
          type="button"
          onClick={reset}
          className="px-4 py-1.5 rounded-lg border border-border bg-background text-foreground text-sm font-medium hover:bg-accent transition-colors"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
