import { Box, Text } from "ink";
import { useSyncExternalStore } from "react";
import pkg from "../../package.json" with { type: "json" };
import { Banner } from "./banner";
import {
  formatIdle,
  getLinkState,
  type SandboxRow,
  subscribeLinkState,
} from "./link-store";

// 1 Hz clock so relative IDLE times re-render. This is display-only; it never
// polls the provider (structural changes arrive via link-store events).
let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb);
  if (!clockTimer) {
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      for (const fn of clockListeners) fn();
    }, 1000);
    clockTimer.unref?.();
  }
  return () => {
    clockListeners.delete(cb);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

function getClock(): number {
  return clockNow;
}

function statusCell(row: SandboxRow): { color: string; text: string } {
  if (row.status === "ready") return { color: "green", text: "● Live" };
  if (row.status === "spawning")
    return { color: "yellow", text: "◌ Starting…" };
  return { color: "red", text: `✗ Error: ${row.error ?? ""}` };
}

export function LinkApp() {
  const state = useSyncExternalStore(subscribeLinkState, getLinkState);
  const now = useSyncExternalStore(subscribeClock, getClock);
  const rows = [...state.sandboxes.values()].sort((a, b) =>
    a.handle.localeCompare(b.handle),
  );

  return (
    <Box flexDirection="column">
      <Banner version={pkg.version} />

      <Box marginBottom={1}>
        <Text dimColor>{"─".repeat(80)}</Text>
      </Box>

      <Box>
        <Text>{"Connection".padEnd(16)}</Text>
        {state.cluster === "linked" ? (
          <Text color="green">✓ Connected to deco</Text>
        ) : state.cluster === "connecting" ? (
          <Text color="yellow">◌ Connecting…</Text>
        ) : (
          <Text color="red">✗ Disconnected</Text>
        )}
      </Box>
      <Box>
        <Text>{"Preview server".padEnd(16)}</Text>
        {state.ingressUrl ? (
          <Text color="green">✓ Ready at {state.ingressUrl}</Text>
        ) : (
          <Text dimColor>Starting…</Text>
        )}
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          {`${"Computer".padEnd(16)}${state.machine ?? "this computer"} · ${rows.length} of ${state.cap} previews`}
        </Text>
      </Box>

      {rows.length === 0 ? (
        <Text dimColor>No previews running yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            {`${"PROJECT".padEnd(16)}${"STATUS".padEnd(22)}${"REQUESTS".padEnd(10)}${"LAST USED".padEnd(11)}PREVIEW URL`}
          </Text>
          {rows.map((row) => {
            const s = statusCell(row);
            const idle =
              row.activeDispatchCount > 0
                ? "—"
                : formatIdle(now - row.lastChangeAt);
            return (
              <Box key={row.handle}>
                <Text>{row.handle.padEnd(16)}</Text>
                <Text color={s.color}>{s.text.padEnd(22)}</Text>
                <Text>{String(row.activeDispatchCount).padEnd(10)}</Text>
                <Text>{idle.padEnd(11)}</Text>
                <Text dimColor>{row.previewUrl ?? "—"}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {state.daemonError ? (
        <Box marginTop={1}>
          <Text color="red">⚠ {state.daemonError}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
