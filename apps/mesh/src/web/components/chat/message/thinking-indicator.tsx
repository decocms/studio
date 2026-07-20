import { Lightbulb01, Stars01, Target04 } from "@untitledui/icons";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ToolCallShell } from "./parts/tool-call-part/common.tsx";
import type { ChatMessage } from "../types.ts";
import { RUN_STATUS_COPY } from "../run-status.ts";
import { useOptionalChatStream } from "../context.tsx";
import { LiveTimer } from "../../live-timer.tsx";
import { GridLoader } from "../../grid-loader.tsx";
import { formatDuration } from "../../../lib/format-time.ts";
import { useClockTick } from "../../../lib/use-clock-tick.ts";

export type ReasoningPart = Extract<
  ChatMessage["parts"][number],
  { type: "reasoning" }
>;

type ThinkingStage = "planning" | "thinking";

interface ThinkingStageConfig {
  icon: ReactNode;
  label: string;
  detail: string;
}

const THINKING_STAGES: Record<ThinkingStage, ThinkingStageConfig> = {
  planning: {
    icon: (
      <Target04
        className="text-muted-foreground shrink-0 animate-pulse"
        size={14}
      />
    ),
    label: "Planning next moves",
    detail: "Deciding how to approach the request",
  },
  thinking: {
    icon: (
      <Stars01
        className="text-muted-foreground shrink-0 animate-pulse"
        size={14}
      />
    ),
    label: "Thinking",
    detail: "Working through the next response",
  },
};

const PLANNING_DURATION = 1200;

function ThoughtSummaryShell({
  icon,
  title,
  summary,
  detail,
  state,
  detailVariant = "prose",
  latency,
  trailing,
}: {
  icon: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  detail?: string | null;
  state: "loading" | "error" | "idle";
  detailVariant?: "code" | "prose";
  latency?: number;
  trailing?: ReactNode;
}) {
  return (
    <ToolCallShell
      icon={icon}
      title={title}
      summary={summary}
      detail={detail}
      state={state}
      detailVariant={detailVariant}
      latency={latency}
      trailing={trailing}
    />
  );
}

function RunStatusIndicator({ startedAt }: { startedAt: number | null }) {
  const stage = useOptionalChatStream()?.runStatusStage ?? null;
  const [fallbackStage, setFallbackStage] = useState<ThinkingStage>("planning");

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (stage !== null) return;
    const planningTimer = setTimeout(() => {
      setFallbackStage("thinking");
    }, PLANNING_DURATION);

    return () => {
      clearTimeout(planningTimer);
    };
  }, [stage]);

  if (stage !== null) {
    const copy = RUN_STATUS_COPY[stage];
    return (
      <ThoughtSummaryShell
        icon={<Stars01 className="size-4" />}
        title={`${copy.label}...`}
        summary={copy.detail}
        state="loading"
        trailing={startedAt !== null && <LiveTimer since={startedAt} />}
      />
    );
  }

  const config = THINKING_STAGES[fallbackStage];

  return (
    <ThoughtSummaryShell
      icon={config.icon}
      title={`${config.label}...`}
      summary={config.detail}
      state="loading"
      trailing={startedAt !== null && <LiveTimer since={startedAt} />}
    />
  );
}

export function GeneratingFooter({ startedAt }: { startedAt: number }) {
  return (
    <div className="flex items-center gap-2.5 mt-1 pb-1 text-muted-foreground/40 select-none">
      <GridLoader />
      <LiveTimer since={startedAt} />
    </div>
  );
}

// After this long with no streamed content, the turn looks frozen even though
// the model may just be slow to first token (common with proxied/liteLLM
// providers). Surface the elapsed time + a cancel escape hatch rather than a
// silent "Thinking…".
const SLOW_AFTER_MS = 20_000;

/**
 * Waiting state for a turn that has produced no parts yet. Pairs the
 * `RunStatusIndicator` with a live elapsed clock and, once the wait crosses
 * `SLOW_AFTER_MS`, a "taking longer than usual" hint + Cancel. `useClockTick`
 * (singleton interval via useSyncExternalStore — no useEffect) re-renders this
 * once per second so the threshold flips without a per-component timer.
 */
export function ThinkingState({ startedAt }: { startedAt: number | null }) {
  useClockTick(1000);
  const stream = useOptionalChatStream();
  const elapsedMs = startedAt !== null ? Date.now() - startedAt : 0;
  const isSlow = elapsedMs >= SLOW_AFTER_MS;

  return (
    <div className="flex flex-col gap-0.5">
      <RunStatusIndicator startedAt={startedAt} />
      {isSlow && stream?.stop && (
        <div className="flex items-center gap-2 pb-1 text-[13px] text-muted-foreground/60">
          <span>This is taking longer than usual.</span>
          <button
            type="button"
            onClick={() => stream.stop()}
            className="text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

export function ThoughtSummary({
  duration,
  parts,
  isStreaming,
}: {
  duration: number | null;
  parts: ReasoningPart[];
  isStreaming: boolean;
}) {
  const allPartsRedacted = parts.every((part) =>
    part.text?.includes("REDACTED"),
  );

  const thoughtMessage = duration
    ? duration / 1000 > 1
      ? `Thought for ${formatDuration(duration / 1000)}`
      : "Thought"
    : "Thought";

  // Join with newlines (not spaces) so we can extract individual lines
  const rawText = parts
    .map((p) => p.text ?? "")
    .join("\n")
    .trim();
  const lines = rawText.split("\n").filter(Boolean);

  // Streaming: show last line (latest thinking). Done: show first line (topic).
  const summaryLine = isStreaming
    ? (lines[lines.length - 1] ?? "")
    : (lines[0] ?? "");

  const summary =
    !allPartsRedacted && summaryLine
      ? summaryLine.length > 100
        ? summaryLine.slice(0, 100) + "…"
        : summaryLine
      : undefined;

  const fullText = parts.map((p) => p.text ?? "").join("\n\n");
  const detail = !allPartsRedacted && fullText.trim() ? fullText : null;

  const latency =
    !isStreaming && duration != null ? duration / 1000 : undefined;

  return (
    <ThoughtSummaryShell
      icon={
        isStreaming ? (
          <Stars01 className="size-4" />
        ) : (
          <Lightbulb01 className="size-4" />
        )
      }
      title={isStreaming ? "Thinking..." : thoughtMessage}
      summary={summary}
      detail={detail}
      state={isStreaming ? "loading" : "idle"}
      detailVariant="prose"
      latency={latency}
    />
  );
}
