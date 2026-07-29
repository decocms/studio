"use client";

import { type ReactNode, useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@deco/ui/components/sheet.tsx";
import type { ToolSubtaskMetadata } from "../../use-filter-parts.ts";
import { IntegrationIcon } from "@/components/integration-icon";
import { useConnection, type ToolDefinition } from "@/sdk";
import { ArrowUpRight, Tool02, Users03 } from "@untitledui/icons";
import type { TextUIPart } from "ai";
import type { SubtaskToolPart } from "../../../types.ts";
import { useSubtaskRun } from "../../../subtask-runs-context.tsx";
import { useChatTask } from "../../../context.tsx";
import { useProjectContext } from "@/sdk";
import { useSubtaskStream } from "./use-subtask-stream.ts";
import { MemoizedMarkdown } from "../../../markdown.tsx";
import { MessageUsageStats } from "../../../usage-stats.tsx";
import type { UsageStats as UsageStatsType } from "@/lib/usage-utils.ts";
import { MessageTextPart } from "../text-part.tsx";
import { extractTextFromOutput, getToolPartErrorText } from "../utils.ts";
import { ToolCallShell } from "./common.tsx";
import { getEffectiveState } from "./utils.tsx";

/**
 * Subtask tool output contract (set by createSubtaskTool's execute generator):
 *   { text: string; error?: string; finishReason?: FinishReason }
 *
 * Mirrors the server's toModelOutput so the UI shows the same content the
 * parent model received. Falls back to the legacy UIMessage shape for
 * historical tool calls predating the structured output.
 */
export function extractSubtaskResponse(output: unknown): string | null {
  // ponytail: i18n keys not available at module scope; wrapped in component
  if (output && typeof output === "object" && !Array.isArray(output)) {
    const o = output as {
      text?: unknown;
      error?: unknown;
      finishReason?: unknown;
    };
    const hasNewShape =
      typeof o.text === "string" ||
      typeof o.error === "string" ||
      typeof o.finishReason === "string";
    if (hasNewShape) {
      if (typeof o.error === "string" && o.error.length > 0) {
        // t("chat.subtask.failedWithError", { error: o.error })
        return `Subtask failed: ${o.error}`;
      }
      const text = typeof o.text === "string" ? o.text.trim() : "";
      const stepLimitHit = o.finishReason === "length";
      if (text) {
        const prefix = stepLimitHit
          ? "[Subtask hit step limit — partial result below; consider narrowing the task.]\n\n"
          : "";
        return prefix + text;
      }
      if (stepLimitHit) {
        return "[Subtask hit step limit before producing a final report. The subagent did work but ran out of steps. Narrow the task or increase the budget.]";
      }
      return "Subtask completed (no output).";
    }
  }
  return extractTextFromOutput(output);
}

/** A backgrounded subtask returns a `{ background: true }` START marker; its run
 *  streams in later as `jobId`-tagged messages, shown in `BackgroundSubtaskCard`. */
function isBackgroundStart(output: unknown): boolean {
  return (
    !!output &&
    typeof output === "object" &&
    (output as { background?: unknown }).background === true
  );
}

interface SubtaskPartProps {
  part: SubtaskToolPart;
  /** Subtask metadata from data part */
  subtaskMeta?: ToolSubtaskMetadata;
  /** Tool annotations from data part (unused in chat) */
  annotations?: ToolDefinition["annotations"];
  /** Latency in seconds from data-tool-metadata part */
  latency?: number;
}

/** Derives the row's display config from a SubtaskToolPart (no agent data).
 *  Pure — NOT a hook (named without the `use` prefix on purpose). */
function buildSubtaskRowConfig({ part, subtaskMeta }: SubtaskPartProps) {
  // ponytail: i18n keys not available at module scope; wrapped in component
  const isInputStreaming =
    part.state === "input-streaming" || part.state === "input-available";
  const isOutputStreaming =
    part.state === "output-available" && part.preliminary === true;
  const isComplete = part.state === "output-available" && !part.preliminary;
  const isError = part.state === "output-error";

  const rawState = getEffectiveState(
    part.state,
    "preliminary" in part ? part.preliminary : false,
  );
  const effectiveState = rawState === "approval" ? "idle" : rawState;

  const fallbackTitle: string = isInputStreaming
    ? "Starting subtask..."
    : isOutputStreaming
      ? "Subtask running..."
      : isComplete
        ? "Subtask completed"
        : isError
          ? "Subtask failed"
          : "Subtask";

  const prompt = part.input?.prompt ?? "";
  const summary =
    part.state === "approval-requested"
      ? "Awaiting approval..."
      : prompt.length > 120
        ? prompt.slice(0, 120) + "…"
        : prompt;

  return {
    fallbackTitle,
    summary,
    usage: subtaskMeta?.usage,
    state: effectiveState,
  };
}

/** Whether a flip control should be offered: only once the call is actually
 *  executing (so it's registered server-side) — not during input-streaming,
 *  where a flip would be a silent no-op and leave the button stuck. */
function isFlippable(part: SubtaskToolPart): boolean {
  if (part.state === "input-available") return true;
  if (part.state === "output-available")
    return "preliminary" in part && part.preliminary === true;
  return false;
}

/** Returns a callback that flips the given (still-running) subtask call to the
 *  background, freeing the thread so the user can keep chatting. The server
 *  fans the request out to the pod running the turn. */
function useFlipToBackground(toolCallId: string): () => Promise<void> {
  const { taskId: threadId } = useChatTask();
  const { org } = useProjectContext();
  return async () => {
    const res = await fetch(
      `/api/${encodeURIComponent(org.slug)}/decopilot/flip/${encodeURIComponent(threadId)}`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ toolCallId }),
      },
    );
    // A non-2xx response won't reject fetch on its own — surface it so the
    // button resets instead of sitting on "Moving to background…" forever.
    if (!res.ok) throw new Error(`flip failed: ${res.status}`);
  };
}

/** A subtle "run in background" pill shown on a still-running foreground
 *  subtask. Clicking POSTs the flip and disables itself; the card re-renders as
 *  the background variant once the flip lands via the stream. */
function FlipToBackgroundButton({ onFlip }: { onFlip: () => Promise<void> }) {
  const t = useT();
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      disabled={pending}
      onClick={async (e) => {
        e.stopPropagation();
        setPending(true);
        try {
          await onFlip();
        } catch {
          setPending(false);
        }
      }}
      className={cn(
        "shrink-0 text-[12px] text-muted-foreground/70 px-2 py-1 rounded-md transition-colors",
        "[@media(hover:hover)]:hover:text-foreground [@media(hover:hover)]:hover:bg-accent/40",
        "disabled:opacity-50",
      )}
    >
      {pending
        ? t("chat.subtask.flipping")
        : t("chat.subtask.flipToBackground")}
    </button>
  );
}

/**
 * The clickable subtask row + the right-side panel it opens. Replaces the old
 * inline collapsible: the row reads as a one-liner in the transcript; the full
 * task/result (or the live background run) opens in a Sheet so a long subagent
 * report doesn't flood the chat column.
 */
function SubtaskCard({
  icon,
  title,
  summary,
  state,
  usage,
  onOpenChange,
  onFlip,
  children,
}: {
  icon: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  state: "loading" | "error" | "idle";
  usage?: UsageStatsType | null;
  /** Notified when the panel opens/closes — lets a caller gate a live tail. */
  onOpenChange?: (open: boolean) => void;
  /** When set and the subtask is still running, show a "run in background"
   *  control (foreground calls only). */
  onFlip?: () => Promise<void>;
  children: ReactNode;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const isLoading = state === "loading";
  const isError = state === "error";

  return (
    <>
      <div className="flex items-center gap-1 w-full">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "group/tool flex items-center gap-2 flex-1 min-w-0 py-2.5 text-left rounded-md transition-colors",
            "[@media(hover:hover)]:hover:bg-accent/30",
            isLoading && "shimmer",
          )}
        >
          <div
            className={cn(
              "relative shrink-0 size-4 flex items-center justify-center [&>svg]:size-4",
              isError
                ? "[&>svg]:text-warning/70"
                : "[&>svg]:text-muted-foreground/75",
            )}
          >
            {icon}
          </div>
          <span
            className={cn(
              "shrink-0 text-[14px] font-normal",
              isError ? "text-warning/80" : "text-foreground",
            )}
          >
            {title}
          </span>
          {summary ? (
            <span className="min-w-0 flex-1 truncate">
              <span className="text-[12px] text-muted-foreground/60 bg-muted/50 rounded-[3px] px-1 py-px leading-none">
                {summary}
              </span>
            </span>
          ) : (
            <div className="flex-1" />
          )}
          <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/40 opacity-0 transition-opacity [@media(hover:hover)]:group-hover/tool:opacity-100" />
          <MessageUsageStats usage={usage} />
        </button>
        {onFlip && isLoading ? (
          <FlipToBackgroundButton onFlip={onFlip} />
        ) : null}
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-2xl flex flex-col p-0 gap-0"
        >
          <SheetHeader className="px-4 py-3 border-b border-border shrink-0">
            <SheetTitle className="flex items-center gap-2 text-sm font-medium">
              <span className="flex items-center [&>svg]:size-4 [&>svg]:text-muted-foreground/75">
                {icon}
              </span>
              {title}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4">
            {children}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/** Panel body for a completed/streaming inline subtask: the task + its result. */
function SubtaskResultBody({ part }: { part: SubtaskToolPart }) {
  const t = useT();
  const isError = part.state === "output-error";
  const prompt = part.input?.prompt ?? "No prompt provided";
  const response = isError
    ? getToolPartErrorText(part)
    : (extractSubtaskResponse(part.output) ?? "");

  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="text-xs font-medium text-muted-foreground/70 mb-1.5">
          {t("chat.subtask.taskLabel")}
        </h3>
        <p className="text-[13px] text-foreground/90 whitespace-pre-wrap wrap-break-word">
          {prompt}
        </p>
      </section>
      <section>
        <h3 className="text-xs font-medium text-muted-foreground/70 mb-1.5">
          {isError
            ? t("chat.subtask.errorLabel")
            : t("chat.subtask.resultLabel")}
        </h3>
        {response.trim() ? (
          <MemoizedMarkdown id={`${part.toolCallId}-result`} text={response} />
        ) : (
          <p className="text-[13px] text-muted-foreground/60 italic">
            {t("chat.subtask.running")}
          </p>
        )}
      </section>
    </div>
  );
}

const NESTED_INPUT_MAX_CHARS = 600;

/** A single nested tool call — name + INPUT only (outputs are hidden). A custom
 *  row, not the full `MessagePart` switch, which would cycle via `assistant.tsx`. */
function NestedToolCall({
  part,
}: {
  part: { type?: string; toolName?: string; input?: unknown };
}) {
  const type = part.type ?? "";
  const name =
    type === "dynamic-tool" ? (part.toolName ?? "tool") : type.slice(5);
  const inputStr = part.input != null ? JSON.stringify(part.input) : "";
  const summary =
    inputStr.length > 80 ? `${inputStr.slice(0, 80)}…` : inputStr || undefined;
  // Cap the expanded input — a `write` carries the whole file body otherwise.
  const pretty =
    part.input != null ? JSON.stringify(part.input, null, 2) : null;
  const detail =
    pretty && pretty.length > NESTED_INPUT_MAX_CHARS
      ? `${pretty.slice(0, NESTED_INPUT_MAX_CHARS)}\n… (${pretty.length - NESTED_INPUT_MAX_CHARS} more characters)`
      : pretty;
  return (
    <ToolCallShell
      icon={<Tool02 />}
      title={name}
      summary={summary}
      state="idle"
      detail={detail}
      detailVariant="code"
    />
  );
}

/** Panel body for a backgrounded subtask: its run's messages (tagged
 *  `subtaskJobId`, filtered from the top level) stream in here live. */
function BackgroundSubtaskBody({
  jobId,
  prompt,
  items,
  streaming,
}: {
  jobId: string | undefined;
  prompt: string;
  items: unknown[];
  streaming: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h3 className="text-xs font-medium text-muted-foreground/70 mb-1.5">
          {t("chat.subtask.taskLabel")}
        </h3>
        <p className="text-[13px] text-foreground/90 whitespace-pre-wrap wrap-break-word">
          {prompt}
        </p>
      </section>
      <section className="flex flex-col gap-3 sm:gap-2">
        {items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground/60 italic py-1">
            {t("chat.subtask.runningInBackground")}
          </p>
        ) : (
          items.map((raw, i) => {
            const p = raw as {
              type?: string;
              text?: string;
              state?: string;
              toolName?: string;
              input?: unknown;
            };
            const type = p.type ?? "";
            if (type === "text") {
              if (!p.text?.trim()) return null;
              return (
                <MessageTextPart
                  key={`${jobId}-sub-${i}`}
                  id={`${jobId}-sub-${i}`}
                  part={raw as TextUIPart}
                  animate={streaming}
                />
              );
            }
            // Hidden bookkeeping tools (same as the top-level renderer) + data
            // parts carry no useful "tool call" signal here.
            if (
              type === "dynamic-tool" ||
              (type.startsWith("tool-") &&
                type !== "tool-todo_write" &&
                type !== "tool-update_interests")
            ) {
              return <NestedToolCall key={`${jobId}-sub-${i}`} part={p} />;
            }
            return null;
          })
        )}
      </section>
    </div>
  );
}

/** Backgrounded subtask: a row whose panel tails the subagent's OWN live stream
 *  (`…/jobs/:jobId/stream`) while the panel is open, falling back to the
 *  persisted nested rows once the run completes / the live buffer is purged. */
function BackgroundSubtaskCard({ part }: SubtaskPartProps) {
  const t = useT();
  const jobId = (part.output as { jobId?: string } | undefined)?.jobId;
  const { taskId: threadId } = useChatTask();
  const { org } = useProjectContext();
  const [open, setOpen] = useState(false);

  // Persisted nested run (after the reaction refetch brings the rows in).
  const persisted = useSubtaskRun(jobId);
  // Live tail — only while the panel is open.
  const live = useSubtaskStream({
    orgSlug: org.slug,
    threadId,
    jobId,
    enabled: open,
  });

  const liveItems = live.messages.flatMap((m) => m.parts ?? []);
  const persistedItems = persisted.flatMap((m) => m.parts ?? []);
  const items = liveItems.length > 0 ? liveItems : persistedItems;

  const prompt = part.input?.prompt ?? "No prompt provided";
  const summary = prompt.length > 120 ? `${prompt.slice(0, 120)}…` : prompt;
  // "Running" until the completed run's rows are persisted (the reaction-turn
  // refetch). The live tail's own streaming flag drives the panel body.
  const running = persisted.length === 0;

  return (
    <SubtaskCard
      icon={
        <IntegrationIcon
          icon={undefined}
          name={t("chat.subtask.subtaskNoun")}
          size="2xs"
          className="rounded-xs"
          fallbackIcon={<Users03 />}
        />
      }
      title={t("chat.subtask.subtaskNoun")}
      summary={summary}
      state={running ? "loading" : "idle"}
      onOpenChange={setOpen}
    >
      <BackgroundSubtaskBody
        jobId={jobId}
        prompt={prompt}
        items={items}
        streaming={live.streaming || running}
      />
    </SubtaskCard>
  );
}

export function SubtaskPartFallback(props: SubtaskPartProps) {
  const t = useT();
  const onFlip = useFlipToBackground(props.part.toolCallId);
  if (isBackgroundStart(props.part.output))
    return <BackgroundSubtaskCard {...props} />;
  const { fallbackTitle, summary, usage, state } = buildSubtaskRowConfig(props);
  return (
    <SubtaskCard
      icon={
        <IntegrationIcon
          icon={undefined}
          name={t("chat.subtask.subtaskNoun")}
          size="2xs"
          className="rounded-xs"
          fallbackIcon={<Users03 />}
        />
      }
      title={fallbackTitle}
      summary={summary}
      state={state}
      usage={usage}
      onFlip={isFlippable(props.part) ? onFlip : undefined}
    >
      <SubtaskResultBody part={props.part} />
    </SubtaskCard>
  );
}

/**
 * Suspends on the delegation-target fetch. Agents are stored as VIRTUAL
 * connections, so the connection collection resolves both persisted agents
 * and concrete MCP targets through one query. MUST be wrapped in
 * <Suspense fallback={<SubtaskPartFallback ... />}> by the caller.
 */
export function SubtaskPart(props: SubtaskPartProps) {
  const t = useT();
  const target = useConnection(props.part.input?.agent_id);
  const onFlip = useFlipToBackground(props.part.toolCallId);
  if (isBackgroundStart(props.part.output))
    return <BackgroundSubtaskCard {...props} />;
  const { fallbackTitle, summary, usage, state } = buildSubtaskRowConfig(props);

  return (
    <SubtaskCard
      icon={
        <IntegrationIcon
          icon={target?.icon}
          name={target?.title ?? t("chat.subtask.subtaskNoun")}
          size="2xs"
          className="rounded-xs"
          fallbackIcon={<Users03 />}
        />
      }
      title={target?.title ?? fallbackTitle}
      summary={summary}
      state={state}
      usage={usage}
      onFlip={isFlippable(props.part) ? onFlip : undefined}
    >
      <SubtaskResultBody part={props.part} />
    </SubtaskCard>
  );
}
