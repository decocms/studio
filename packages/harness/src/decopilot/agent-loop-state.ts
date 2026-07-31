import type { ToolSet } from "ai";

export interface AgentLoopMessageHistory {
  role: string;
  parts: ReadonlyArray<unknown>;
}

export interface AgentLoopPendingImage {
  url: string;
  mediaType?: string;
  pageUrl?: string;
  label?: string;
}

export interface AgentLoopModeConfig {
  isPlanMode: boolean;
  forcedFirstStepTool?: string | null;
}

export function reconstructEnabledTools(
  messages: ReadonlyArray<AgentLoopMessageHistory>,
  availableToolNames: Set<string>,
): Set<string> {
  const enabled = new Set<string>();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.parts) {
      const p = part as {
        toolName?: string;
        result?: { enabled?: string[] };
      };
      if (
        (p.toolName === "enable_tool" || p.toolName === "enable_tools") &&
        p.result
      ) {
        const result = p.result;
        if (Array.isArray(result.enabled)) {
          for (const name of result.enabled) {
            const normalized = name.replace(/[^a-zA-Z0-9_]/g, "_");
            if (availableToolNames.has(normalized)) {
              enabled.add(normalized);
            } else if (availableToolNames.has(name)) {
              enabled.add(name);
            }
          }
        }
      }
    }
  }
  return enabled;
}

export interface AgentPrepareStepOptions {
  modeConfig: AgentLoopModeConfig;
  streamTools: ToolSet;
  builtInToolNames: string[];
  enabledTools: Set<string>;
  toolAnnotations: Map<string, { readOnlyHint?: boolean }>;
  pendingImages: AgentLoopPendingImage[];
  /**
   * External activity that happened while the run was working (today: new
   * comments on the linked task), appended as a USER message at the next step
   * boundary. Shared by reference and drained in place, like `pendingImages`.
   *
   * User role, not system: a system message would sit inside the cached prefix
   * and invalidate it on every arrival. As a trailing user turn it costs one
   * uncached block and leaves the prefix intact.
   */
  pendingContext?: string[];
  hasEnableTool: boolean;
}

export function createAgentPrepareStep(opts: AgentPrepareStepOptions) {
  const forcedFirstStepToolName =
    opts.modeConfig.forcedFirstStepTool &&
    opts.modeConfig.forcedFirstStepTool in opts.streamTools
      ? opts.modeConfig.forcedFirstStepTool
      : null;
  let stepIndex = 0;

  // biome-ignore lint/suspicious/noExplicitAny: complex AI SDK prepareStep generics
  return (stepArgs: any) => {
    const stepMessages = stepArgs.messages;
    const isFirstStep = stepIndex === 0;
    stepIndex++;

    // biome-ignore lint/suspicious/noExplicitAny: complex AI SDK message content generics
    let withImages: any = stepMessages;
    if (opts.pendingContext?.length) {
      const notes = opts.pendingContext.splice(0, opts.pendingContext.length);
      withImages = [
        ...withImages,
        { role: "user", content: notes.join("\n\n") },
      ];
    }
    if (opts.pendingImages.length > 0) {
      const imageParts = opts.pendingImages.splice(
        0,
        opts.pendingImages.length,
      );
      const content: unknown[] = [];
      for (const img of imageParts) {
        content.push({
          type: "text",
          text:
            img.label ??
            (img.pageUrl ? `[Screenshot of ${img.pageUrl}]` : "[Image]"),
        });
        if (img.url.startsWith("data:")) {
          const match = img.url.match(/^data:([^;]+);base64,(.+)$/s);
          if (match) {
            content.push({
              type: "image",
              image: match[2],
              mimeType: match[1],
            });
          }
        } else {
          content.push({
            type: "image",
            image: new URL(img.url),
          });
        }
      }
      withImages = [...withImages, { role: "user", content }];
    }

    let activeToolNames = [
      ...opts.builtInToolNames,
      ...(opts.hasEnableTool ? ["enable_tool"] : []),
      ...opts.enabledTools,
    ];

    if (opts.modeConfig.isPlanMode) {
      activeToolNames = activeToolNames.filter((name) => {
        if (
          opts.builtInToolNames.includes(name) ||
          (opts.hasEnableTool && name === "enable_tool")
        ) {
          return true;
        }
        const annotations = opts.toolAnnotations.get(name);
        return annotations?.readOnlyHint === true;
      });
    }

    const forcedToolName =
      forcedFirstStepToolName && isFirstStep ? forcedFirstStepToolName : null;

    return {
      activeTools: activeToolNames as (keyof typeof opts.streamTools)[],
      messages: withImages,
      ...(forcedToolName && {
        toolChoice: {
          type: "tool" as const,
          toolName: forcedToolName as never,
        },
      }),
    };
  };
}
