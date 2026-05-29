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
  if (row.status === "ready") return { color: "green", text: "● ready" };
  if (row.status === "spawning") return { color: "yellow", text: "◌ spawning" };
  return { color: "red", text: `✗ failed: ${row.error ?? ""}` };
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
        <Text>Cluster </Text>
        {state.cluster === "linked" ? (
          <Text color="green">✓ linked</Text>
        ) : state.cluster === "connecting" ? (
          <Text color="yellow">◌ connecting</Text>
        ) : (
          <Text color="red">✗ disconnected</Text>
        )}
      </Box>
      <Box>
        <Text>Ingress </Text>
        {state.ingressUrl ? (
          <Text color="green">✓ {state.ingressUrl}</Text>
        ) : (
          <Text dimColor>starting…</Text>
        )}
      </Box>
      <Box marginBottom={1}>
        <Text dimColor>
          {`Machine   ${state.machine ?? "this machine"} · ${rows.length} / ${state.cap} sandboxes`}
        </Text>
      </Box>

      {rows.length === 0 ? (
        <Text dimColor>No sandboxes yet.</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            {`${"HANDLE".padEnd(16)}${"PORT".padEnd(8)}${"STATUS".padEnd(22)}${"ACTIVE".padEnd(8)}${"IDLE".padEnd(8)}PREVIEW`}
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
                <Text>{String(row.port ?? "—").padEnd(8)}</Text>
                <Text color={s.color}>{s.text.padEnd(22)}</Text>
                <Text>{String(row.activeDispatchCount).padEnd(8)}</Text>
                <Text>{idle.padEnd(8)}</Text>
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
