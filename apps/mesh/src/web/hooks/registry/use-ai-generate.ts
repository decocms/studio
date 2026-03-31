import { useRef, useState } from "react";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";

type GenerateType =
  | "description"
  | "short_description"
  | "tags"
  | "categories"
  | "readme";

type GenerateContext = {
  name?: string;
  provider?: string;
  url?: string;
  owner?: string;
  repositoryUrl?: string;
  description?: string;
  shortDescription?: string;
  tags?: string[];
  categories?: string[];
  availableTags?: string[];
  availableCategories?: string[];
  tools?: Array<{ name: string; description?: string | null }>;
};

type ToolResult<T> = {
  structuredContent?: T;
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
};

type GenerateOutput = {
  result?: string;
  items?: string[];
};

export function useAIGenerate() {
  const { org } = useProjectContext();
  const [loadingType, setLoadingType] = useState<GenerateType | null>(null);
  const inflightRef = useRef(0);
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
  });

  const generate = async (params: {
    type: GenerateType;
    llmConnectionId: string;
    modelId: string;
    context: GenerateContext;
  }): Promise<GenerateOutput> => {
    inflightRef.current += 1;
    setLoadingType(params.type);
    try {
      const result = (await client.callTool({
        name: "REGISTRY_AI_GENERATE",
        arguments: params,
      })) as ToolResult<GenerateOutput>;

      if (result.isError) {
        const message =
          result.content?.find((item) => item.type === "text")?.text ??
          "Failed to generate content";
        throw new Error(message);
      }

      return (result.structuredContent ?? result) as GenerateOutput;
    } finally {
      inflightRef.current -= 1;
      if (inflightRef.current === 0) {
        setLoadingType(null);
      }
    }
  };

  return {
    generate,
    loadingType,
    isGenerating: loadingType !== null,
  };
}
