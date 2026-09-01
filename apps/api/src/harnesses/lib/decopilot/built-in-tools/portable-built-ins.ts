import type { ToolSet, UIMessageStreamWriter } from "ai";
import { userAskTool } from "./user-ask";
import { todoWriteTool } from "./todo-write";
import { proposePlanTool } from "./propose-plan";
import { createReadToolOutputTool } from "./read-tool-output";
import { type VirtualClient } from "./sandbox";
import type { ToolApprovalLevel } from "../mcp-tools";
import {
  createPortableGenerateImageTool,
  GenerateImageInputSchema,
  type PortableImageModelInfo,
  type PortableImageProvider,
  type PortableMediaObjectStorage,
} from "./portable-media-tools";
import { makeBackgroundable } from "./backgroundable";

export interface BuildPortableBuiltInToolsParams {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  toolApprovalLevel: ToolApprovalLevel;
  isPlanMode: boolean;
  objectStorage?: PortableMediaObjectStorage | null;
  imageTool?: {
    provider: PortableImageProvider;
    imageModelInfo: PortableImageModelInfo;
  };
}

export function buildPortableBuiltInTools(
  params: BuildPortableBuiltInToolsParams,
): ToolSet {
  const { writer, toolOutputMap, objectStorage, imageTool } = params;
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    todo_write: todoWriteTool,
    propose_plan: proposePlanTool,
    read_tool_output: createReadToolOutputTool({ toolOutputMap }),
  };

  if (imageTool) {
    tools.generate_image = makeBackgroundable(
      "generate_image",
      GenerateImageInputSchema,
      createPortableGenerateImageTool(writer, {
        ...imageTool,
        objectStorage,
      }),
      null,
    );
  }

  return tools as ToolSet;
}
