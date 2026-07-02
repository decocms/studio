import { Box, Text, useInput } from "ink";
import { useSyncExternalStore } from "react";
import pkg from "../../package.json" with { type: "json" };
import { Banner } from "./banner";
import { formatConfirm } from "./link-confirm";
import { dispatchIntent } from "./link-dispatch";
import { keyToIntent } from "./link-keymap";
import { orderedHandles } from "./link-selection";
import {
  getLinkState,
  type SandboxRow,
  subscribeLinkState,
} from "./link-store";

function statusCell(
  row: SandboxRow,
  removing: boolean,
): { color: string; text: string } {
  if (removing) return { color: "yellow", text: "◌ Removing…" };
  if (row.status === "ready") return { color: "green", text: "● Live" };
  if (row.status === "spawning")
    return { color: "yellow", text: "◌ Starting…" };
  if (row.status === "stopped") return { color: "gray", text: "■ Stopped" };
  if (row.status === "missing") return { color: "yellow", text: "□ Missing" };
  if (row.status === "merged") return { color: "cyan", text: "✓ Merged" };
  if (row.status === "invalid") return { color: "red", text: "✗ Invalid" };
  if (row.status === "failed")
    return { color: "red", text: `✗ Failed: ${row.error ?? "failed"}` };
  return { color: "red", text: `✗ Error: ${row.error ?? ""}` };
}

// Shared by the header and every row so columns can never drift. Each fixed
// column gets a 1-cell right gutter (marginRight) so a fully-truncated cell
// still separates from the next. PREVIEW URL is last and takes the rest.
const COLS = {
  project: 18,
  branch: 22,
  status: 14,
} as const;

export function LinkApp() {
  const state = useSyncExternalStore(subscribeLinkState, getLinkState);
  const rows = [...state.sandboxes.values()].sort((a, b) =>
    a.handle.localeCompare(b.handle),
  );

  const handles = orderedHandles(state.sandboxes);
  const selected =
    state.selectedHandle !== null && handles.includes(state.selectedHandle)
      ? state.selectedHandle
      : (handles[0] ?? null);

  useInput((input, key) => {
    const intent = keyToIntent(input, key, state.pendingConfirm !== null);
    if (intent !== null) dispatchIntent(intent);
  });

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
            <Box width={2} flexShrink={0} />
            <Box width={COLS.project} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                PROJECT
              </Text>
            </Box>
            <Box width={COLS.branch} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                BRANCH
              </Text>
            </Box>
            <Box width={COLS.status} flexShrink={0} marginRight={1}>
              <Text dimColor wrap="truncate-end">
                STATUS
              </Text>
            </Box>
            <Box flexGrow={1}>
              <Text dimColor wrap="truncate-end">
                PREVIEW URL
              </Text>
            </Box>
          </Box>
          {rows.map((row) => {
            const s = statusCell(row, state.removingHandles.has(row.handle));
            const isSelected = row.handle === selected;
            return (
              <Box key={row.handle}>
                <Box width={2} flexShrink={0}>
                  <Text color="cyan">{isSelected ? "›" : " "}</Text>
                </Box>
                <Box width={COLS.project} flexShrink={0} marginRight={1}>
                  <Text bold={isSelected} wrap="truncate-end">
                    {row.projectName ?? row.handle}
                  </Text>
                </Box>
                <Box width={COLS.branch} flexShrink={0} marginRight={1}>
                  <Text bold={isSelected} wrap="truncate-end">
                    {row.branch ?? "—"}
                  </Text>
                </Box>
                <Box width={COLS.status} flexShrink={0} marginRight={1}>
                  <Text color={s.color} bold={isSelected} wrap="truncate-end">
                    {s.text}
                  </Text>
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

      {state.pendingConfirm ? (
        <Box marginTop={1}>
          <Text color="yellow">{formatConfirm(state.pendingConfirm)}</Text>
        </Box>
      ) : null}
      {state.actionError ? (
        <Box marginTop={1}>
          <Text color="red">✗ {state.actionError}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text dimColor>↑↓ move · s stop · d delete · o open · q quit</Text>
      </Box>
    </Box>
  );
}
