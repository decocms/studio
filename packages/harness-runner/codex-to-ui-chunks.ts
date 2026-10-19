import type { UIMessageChunk } from "ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function tool(
  item: Record<string, unknown>,
): { name: string; input: unknown } | null {
  switch (item.type) {
    case "commandExecution":
      return { name: "bash", input: { command: item.command, cwd: item.cwd } };
    case "fileChange":
      return { name: "edit", input: { changes: item.changes } };
    case "mcpToolCall":
      return {
        name:
          item.server === "studio"
            ? String(item.tool)
            : `mcp__${item.server}__${item.tool}`,
        input: item.arguments,
      };
    case "webSearch":
      return {
        name: "web_search",
        input: { query: item.query, action: item.action },
      };
    case "imageView":
      return { name: "read", input: { path: item.path } };
    case "collabToolCall":
    case "collabAgentToolCall":
      return {
        name: "subtask",
        input: { prompt: item.prompt, tool: item.tool },
      };
    default:
      return null;
  }
}

/** Translates app-server notifications without exposing runtime configuration or credentials. */
export class CodexChunkTranslator {
  private blocks = new Map<string, "text" | "reasoning">();
  private streamed = new Set<string>();
  private calls = new Set<string>();
  private completed = new Set<string>();
  private planUpdates = 0;
  awaitingUser = false;
  usage: unknown;
  private usageBaseline:
    | { input: number; output: number; cached: number }
    | undefined;

  close(): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];
    for (const [id, kind] of this.blocks)
      chunks.push({ type: kind === "text" ? "text-end" : "reasoning-end", id });
    this.blocks.clear();
    return chunks;
  }

  private delta(
    id: string,
    kind: "text" | "reasoning",
    delta: string,
  ): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];
    if (!this.blocks.has(id)) {
      this.blocks.set(id, kind);
      chunks.push({
        type: kind === "text" ? "text-start" : "reasoning-start",
        id,
      });
    }
    this.streamed.add(id);
    chunks.push({
      type: kind === "text" ? "text-delta" : "reasoning-delta",
      id,
      delta,
    });
    return chunks;
  }

  question(params: Record<string, unknown>): UIMessageChunk[] {
    const questions = Array.isArray(params.questions)
      ? params.questions.map(record)
      : [];
    const only = questions.length === 1 ? questions[0] : undefined;
    const options =
      only && Array.isArray(only.options)
        ? only.options.map(record).map((o) => String(o.label))
        : [];
    const input =
      only && options.length >= 2
        ? { prompt: String(only.question), type: "choice", options }
        : {
            prompt: questions.map((q) => String(q.question)).join("\n"),
            type: "text",
          };
    this.awaitingUser = true;
    return [
      ...this.close(),
      {
        type: "tool-input-available",
        toolCallId: String(params.itemId),
        toolName: "user_ask",
        input,
      },
    ];
  }

  translate(method: string, params: Record<string, unknown>): UIMessageChunk[] {
    if (method === "turn/plan/updated" && Array.isArray(params.plan)) {
      const todos = params.plan
        .map(record)
        .filter((item) => typeof item.step === "string")
        .map((item) => ({
          content: item.step,
          activeForm: item.step,
          status:
            item.status === "completed"
              ? "completed"
              : item.status === "inProgress"
                ? "in_progress"
                : "pending",
        }));
      const toolCallId = `codex-plan-${++this.planUpdates}`;
      return [
        ...this.close(),
        {
          type: "tool-input-available",
          toolCallId,
          toolName: "todo_write",
          input: { todos },
        },
        {
          type: "tool-output-available",
          toolCallId,
          output: { ok: true, count: todos.length },
        },
        { type: "finish-step" },
        { type: "start-step" },
      ];
    }
    if (method === "thread/tokenUsage/updated") {
      const tokenUsage = record(params.tokenUsage);
      const total = record(tokenUsage.total);
      const last = record(tokenUsage.last);
      const count = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) ? value : 0;
      // App-server reports session totals. The first update includes this turn's
      // first model request in `last`, so subtract the preceding conversation.
      this.usageBaseline ??= {
        input: count(total.inputTokens) - count(last.inputTokens),
        output: count(total.outputTokens) - count(last.outputTokens),
        cached: count(total.cachedInputTokens) - count(last.cachedInputTokens),
      };
      const inputTokens = Math.max(
        0,
        count(total.inputTokens) - this.usageBaseline.input,
      );
      const outputTokens = Math.max(
        0,
        count(total.outputTokens) - this.usageBaseline.output,
      );
      this.usage = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cachedInputTokens: Math.max(
          0,
          count(total.cachedInputTokens) - this.usageBaseline.cached,
        ),
        contextTokens: count(last.inputTokens),
      };
      return [];
    }
    if (
      ["item/agentMessage/delta", "item/reasoning/summaryTextDelta"].includes(
        method,
      )
    ) {
      if (
        typeof params.itemId !== "string" ||
        typeof params.delta !== "string" ||
        this.completed.has(params.itemId)
      )
        return [];
      return this.delta(
        params.itemId,
        method === "item/agentMessage/delta" ? "text" : "reasoning",
        params.delta,
      );
    }
    if (method !== "item/started" && method !== "item/completed") return [];
    const item = record(params.item);
    if (typeof item.id !== "string" || this.completed.has(item.id)) return [];
    const id = item.id;
    const done = method === "item/completed";
    const chunks: UIMessageChunk[] = [];
    const call = tool(item);
    if (call) {
      if (!this.calls.has(id)) {
        chunks.push(...this.close(), {
          type: "tool-input-available",
          toolCallId: id,
          toolName: call.name,
          input: call.input,
        });
        this.calls.add(id);
      }
      if (done) {
        const failed =
          item.status === "failed" ||
          item.status === "declined" ||
          Boolean(item.error);
        chunks.push(
          failed
            ? {
                type: "tool-output-error",
                toolCallId: id,
                errorText:
                  typeof item.error === "string"
                    ? item.error
                    : JSON.stringify(item.error ?? item),
              }
            : {
                type: "tool-output-available",
                toolCallId: id,
                output:
                  item.type === "commandExecution"
                    ? {
                        stdout: item.aggregatedOutput ?? "",
                        exitCode: item.exitCode,
                      }
                    : (item.result ?? item),
              },
        );
        chunks.push({ type: "finish-step" }, { type: "start-step" });
      }
    } else if (
      done &&
      (item.type === "agentMessage" || item.type === "reasoning")
    ) {
      if (!this.streamed.has(id)) {
        const text =
          item.type === "agentMessage"
            ? item.text
            : Array.isArray(item.summary)
              ? item.summary.join("\n")
              : "";
        if (typeof text === "string" && text)
          chunks.push(
            ...this.delta(
              id,
              item.type === "agentMessage" ? "text" : "reasoning",
              text,
            ),
          );
      }
      const kind = this.blocks.get(id);
      if (kind) {
        chunks.push({
          type: kind === "text" ? "text-end" : "reasoning-end",
          id,
        });
        this.blocks.delete(id);
      }
    } else if (done && item.type === "plan" && typeof item.text === "string") {
      this.awaitingUser = true;
      chunks.push(...this.close(), {
        type: "tool-input-available",
        toolCallId: id,
        toolName: "propose_plan",
        input: { plan: item.text },
      });
    }
    if (done) this.completed.add(id);
    return chunks;
  }
}
