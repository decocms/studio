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

// Shared by the header and every row so columns can never drift. Each fixed
// column gets a 1-cell right gutter (marginRight) so a fully-truncated cell
// still separates from the next. PREVIEW URL is last and takes the rest.
const COLS = {
  project: 18,
  status: 14,
  requests: 10,
  lastUsed: 11,
} as const;

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
        {state.cluster === "linked" ? (
          <Text color="green">✓ Connected to {state.clusterUrl ?? "deco"}</Text>
        ) : state.cluster === "connecting" ? (
          <Text color="yellow">
            ◌ Connecting to {state.clusterUrl ?? "deco"}…
          </Text>
        ) : (
          <Text color="red">
            ✗ Disconnected from {state.clusterUrl ?? "deco"}
          </Text>
        )}
      </Box>
      <Box>
        {state.ingressUrl ? (
          <Text color="green">✓ Serving at {state.ingressUrl}</Text>
        ) : (
          <Text dimColor>◌ Starting local server…</Text>
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
          <Box>
            <Box width={COLS.project} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                PROJECT
              </Text>
            </Box>
            <Box width={COLS.status} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                STATUS
              </Text>
            </Box>
            <Box width={COLS.requests} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                REQUESTS
              </Text>
            </Box>
            <Box width={COLS.lastUsed} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                LAST USED
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate-end">
                PREVIEW URL
              </Text>
            </Box>
          </Box>
          {rows.map((row) => {
            const s = statusCell(row);
            const idle =
              row.activeDispatchCount > 0
                ? "—"
                : formatIdle(now - row.lastChangeAt);
            return (
              <Box key={row.handle}>
                <Box width={COLS.project} flexShrink={0} marginRight={1}>
                  <Text wrap="truncate-end">{row.handle}</Text>
                </Box>
                <Box width={COLS.status} flexShrink={0} marginRight={1}>
                  <Text color={s.color} wrap="truncate-end">
                    {s.text}
                  </Text>
                </Box>
                <Box width={COLS.requests} flexShrink={0} marginRight={1}>
                  <Text wrap="truncate-end">
                    {String(row.activeDispatchCount)}
                  </Text>
                </Box>
                <Box width={COLS.lastUsed} flexShrink={0} marginRight={1}>
                  <Text wrap="truncate-end">{idle}</Text>
                </Box>
                <Box flexGrow={1}>
                  <Text dimColor wrap="truncate-end">
                    {row.previewUrl ?? "—"}
                  </Text>
                </Box>
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
      {state.logPath ? (
        <Box marginTop={1}>
          <Text dimColor>Logs: {state.logPath}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
