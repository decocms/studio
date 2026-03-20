import { useSyncExternalStore } from "react";

interface TerminalSize {
  rows: number;
  columns: number;
}

function getSnapshot(): TerminalSize {
  return {
    rows: process.stdout.rows || 24,
    columns: process.stdout.columns || 80,
  };
}

function subscribe(callback: () => void): () => void {
  process.stdout.on("resize", callback);
  return () => {
    process.stdout.off("resize", callback);
  };
}

export function useTerminalSize(): TerminalSize {
  return useSyncExternalStore(subscribe, getSnapshot);
}
