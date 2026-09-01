import type React from "react";
import {
  BookOpen01,
  Code02,
  Database01,
  Edit01,
  Edit02,
  File06,
  Folder,
  SearchMd,
  Server01,
  TerminalSquare,
  Tool01,
} from "@untitledui/icons";
import type { TranslationKey } from "@/i18n/use-t.ts";

export interface ToolDisplay {
  /** Icon component — rendered with `size-4 text-muted-foreground` by the caller */
  icon: React.ComponentType<{ className?: string; size?: number }>;
  /** i18n key for the human-readable label; overrides the toTitleCase fallback when set */
  labelKey?: TranslationKey;
}

/**
 * Maps clean tool names (after prefix-stripping) to display metadata.
 * Only built-in tools need entries here — MCP passthrough tools get their
 * titles from listTools and fall back to Atom02 / toTitleCase.
 */
export const TOOL_DISPLAY_MAP: Record<string, ToolDisplay> = {
  // VM file tools
  read: { icon: File06, labelKey: "chat.generic.tool.read" },
  write: { icon: Edit01, labelKey: "chat.generic.tool.write" },
  edit: { icon: Edit02, labelKey: "chat.generic.tool.edit" },
  grep: { icon: SearchMd, labelKey: "chat.generic.tool.grep" },
  glob: { icon: Folder, labelKey: "chat.generic.tool.glob" },
  bash: { icon: TerminalSquare, labelKey: "chat.generic.tool.bash" },

  // Resource / context tools
  read_tool_output: {
    icon: File06,
    labelKey: "chat.generic.tool.readToolOutput",
  },
  read_resource: {
    icon: Database01,
    labelKey: "chat.generic.tool.readResource",
  },
  read_prompt: { icon: BookOpen01, labelKey: "chat.generic.tool.readPrompt" },
  skill: { icon: BookOpen01, labelKey: "chat.generic.tool.skill" },

  // System tools
  enable_tool: { icon: Tool01, labelKey: "chat.generic.tool.enableTool" },
  open_in_agent: { icon: Server01, labelKey: "chat.generic.tool.openInAgent" },

  // Sandbox / code execution tools
  sandbox: { icon: Code02, labelKey: "chat.generic.tool.sandbox" },

  // Browser / web tools
};
