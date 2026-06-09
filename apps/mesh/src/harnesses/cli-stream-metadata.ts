import type { TextStreamPart, ToolSet } from "ai";
import type { HarnessStreamInput, UsageTotals } from "./types";
import { createUsageAccumulator } from "./usage-accumulator";

export interface CliMetadataOptions {
  input: HarnessStreamInput;
  providerName: "claude-code" | "codex";
  providerMetadataKey: "claude-code" | "codex-app-server";
  extractSessionId: (metadata: unknown) => string | undefined;
}

export interface CliMessageMetadata {
  ({
    part,
  }: {
    part: TextStreamPart<ToolSet>;
  }): Record<string, unknown> | undefined;
  totalTokens(): UsageTotals;
}

export function createCliMessageMetadata(
  options: CliMetadataOptions,
): CliMessageMetadata {
  const { input } = options;
  const usageAcc = createUsageAccumulator();
  let codingAgentSessionId: string | undefined;

  const messageMetadata = (({ part }: { part: TextStreamPart<ToolSet> }) => {
    if (part.type === "start") {
      return {
        agent: { id: input.agent.id ?? null },
        models: {
          credentialId: input.models.credentialId,
          thinking: {
            ...input.models.thinking,
            title: input.models.thinking.title ?? input.models.thinking.id,
            provider: input.models.thinking.provider ?? undefined,
          },
        },
        created_at: new Date(),
        thread_id: input.threadId,
      };
    }

    if (part.type === "finish-step") {
      const providerMetadataRecord = part.providerMetadata as
        | Record<string, unknown>
        | undefined;
      const providerMetadata =
        providerMetadataRecord?.[options.providerMetadataKey];
      const sessionId = options.extractSessionId(providerMetadata);
      if (sessionId) {
        codingAgentSessionId = sessionId;
      }
      usageAcc.addStep(part.usage, providerMetadataRecord);
      return { usage: usageAcc.buildStepUsage() };
    }

    if (part.type === "finish") {
      const usage = usageAcc.buildFinalUsage({
        totalUsage: part.totalUsage,
        providerKey: input.models.thinking.provider,
      });
      return {
        ...(usage && { usage }),
        ...(codingAgentSessionId && {
          codingAgentSessionId,
          codingAgentProvider: options.providerName,
        }),
      };
    }

    return undefined;
  }) as CliMessageMetadata;

  messageMetadata.totalTokens = () => usageAcc.totalTokens();

  return messageMetadata;
}
