import {
  DynamicToolUIPart,
  ToolUIPart,
  UIDataTypes,
  UIMessage,
  UIMessagePart,
  UITools,
} from "ai";

export function getToolPartErrorText(
  part: Record<string, unknown>,
  fallback = "An unknown error occurred",
): string {
  return "errorText" in part && typeof part.errorText === "string"
    ? part.errorText
    : fallback;
}

/**
 * Safely stringify a value for display, handling non-serializable values.
 * Returns empty string for null/undefined, or a fallback for errors.
 */
export function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "[Non-serializable value]";
  }
}

/** Like {@link safeStringify} but pretty-printed (2-space indent) for expandable detail panels. */
export function safeStringifyFormatted(value: unknown): string {
  const str = safeStringify(value);
  if (str === "" || str === "[Non-serializable value]") return str;
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

const isToolLike = (
  p: UIMessagePart<UIDataTypes, UITools>,
): p is DynamicToolUIPart | ToolUIPart => {
  return p.type === "dynamic-tool" || p.type.startsWith("tool-");
};

export function extractTextFromOutput(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const msg = output as UIMessage;
  if (!Array.isArray(msg.parts)) return null;

  const textParts: string[] = [];
  for (const p of msg.parts) {
    if (p.type === "text" && typeof p.text === "string") {
      textParts.push(p.text);
    } else if (p.type === "reasoning") {
      textParts.push(`## Reasoning\n${p.text}`);
    } else if (p.type === "source-url") {
      textParts.push(`## Source URL\n${p.url}`);
    } else if (p.type === "source-document") {
      textParts.push(`## Source Document\n${p.title}`);
    } else if (p.type === "file") {
      textParts.push(`## File\n${p.filename ?? p.url}`);
    } else if (p.type === "step-start") {
      // noop
    } else if (isToolLike(p)) {
      const toolName = p.type.startsWith("tool-")
        ? p.type.slice(5)
        : (p as DynamicToolUIPart).toolName;

      if (p.state === "input-streaming") {
        textParts.push(`## ${toolName}\nInput streaming...`);
      } else if (p.state === "input-available") {
        const inputStr = safeStringify(p.input).slice(0, 20);
        textParts.push(
          `## ${toolName}\n### Input\n${inputStr || "[No input]"}...`,
        );
      } else if (p.state === "approval-requested") {
        textParts.push(`## ${toolName}\nApproval requested...`);
      } else if (p.state === "approval-responded") {
        textParts.push(`## ${toolName}\nApproval responded...`);
      } else if (p.state === "output-available") {
        const inputStr = safeStringify(p.input).slice(0, 40);
        const outputStr = safeStringify(p.output).slice(0, 40);
        textParts.push(
          p.output != null
            ? `## ${toolName}\nInput: ${inputStr || "[No input]"}...\nOutput: ${outputStr || "[No output]"}...`
            : `## ${toolName}\nInput: ${inputStr || "[No input]"}...\nOutput: Tool responded with no output`,
        );
      } else if (p.state === "output-error") {
        const inputStr = safeStringify(p.input).slice(0, 40);
        textParts.push(
          p.errorText
            ? `## ${toolName}\nInput: ${inputStr || "[No input]"}...\nError: ${p.errorText}`
            : `## ${toolName}\nInput: ${inputStr || "[No input]"}...\nError: Tool responded with an error`,
        );
      } else if (p.state === "output-denied") {
        const inputStr = safeStringify(p.input).slice(0, 40);
        textParts.push(
          `## ${toolName}\nInput: ${inputStr || "[No input]"}...\nOutput: Tool execution was denied`,
        );
      }
    }
  }

  return textParts.length > 0 ? textParts.join("\n\n") : null;
}
