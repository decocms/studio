import { Box, Text } from "ink";
import { useSyncExternalStore } from "react";
import { getCliState, subscribeCliState } from "./cli-store";
import type { LogEntry } from "./log-emitter";
import { useTerminalSize } from "./use-terminal-size";

function statusColor(status: number): string {
  if (status >= 500) return "red";
  if (status >= 400) return "yellow";
  if (status >= 300) return "cyan";
  return "green";
}

interface RequestLogProps {
  logs: LogEntry[];
  headerHeight: number;
}

export function RequestLog({ logs, headerHeight }: RequestLogProps) {
  const { rows } = useTerminalSize();
  const { logFlow } = useSyncExternalStore(subscribeCliState, getCliState);
  const visibleCount = Math.max(1, rows - headerHeight - 1);
  const visible = logFlow ? logs : logs.slice(-visibleCount);

  return (
    <Box flexDirection="column">
      {visible.map((entry, i) => {
        if (entry.rawLine) {
          return (
            <Text key={i} dimColor>
              {entry.rawLine}
            </Text>
          );
        }

        const durationStr =
          entry.duration < 1000
            ? `${entry.duration}ms`
            : `${(entry.duration / 1000).toFixed(1)}s`;

        return (
          <Text key={i}>
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
