import { Box, Text } from "ink";
import type { StoredLogEntry } from "./cli-store";

function statusColor(status: number): string {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "green";
}

// Cap the rendered window so each Ink reconciliation is O(visible) rather
// than O(buffered). The cli-store keeps up to MAX_LOGS (500) entries; we
// only ever paint the tail that could plausibly fit on screen. Without this
// cap, every new log line forced Ink to diff a 500-row tree, which couldn't
// keep up with bursts and flickered. Constant chosen to comfortably exceed
// any realistic terminal height while still bounding the per-frame cost.
const VISIBLE_LOG_LINES = 80;

export function RequestLog({ logs }: { logs: StoredLogEntry[] }) {
  const visible =
    logs.length > VISIBLE_LOG_LINES ? logs.slice(-VISIBLE_LOG_LINES) : logs;
  return (
    <Box flexDirection="column">
      {visible.map((entry) => {
        if (entry.rawLine) {
          return (
            <Text key={entry.id} dimColor>
              {entry.rawLine}
            </Text>
          );
        }

        const durationStr =
          entry.duration < 1000
            ? `${entry.duration}ms`
            : `${(entry.duration / 1000).toFixed(1)}s`;

        return (
          <Text key={entry.id}>
            <Text dimColor>
              {entry.method.padEnd(6)} {entry.path.padEnd(30)}{" "}
            </Text>
            <Text color={statusColor(entry.status)}>{entry.status}</Text>
            <Text dimColor> {durationStr.padStart(8)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
