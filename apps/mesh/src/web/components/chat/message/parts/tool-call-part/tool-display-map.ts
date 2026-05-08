import type React from "react";
import {
  BookOpen01,
  Code01,
  Code02,
  Database01,
  Download01,
  Edit01,
  Edit02,
  File06,
  Folder,
  Globe02,
  Monitor01,
  SearchMd,
  Server01,
  TerminalSquare,
  Tool01,
  Upload01,
  Users03,
} from "@untitledui/icons";

export interface ToolDisplay {
  /** Icon component — rendered with `size-4 text-muted-foreground` by the caller */
  icon: React.ComponentType<{ className?: string; size?: number }>;
  /** Human-readable label; overrides the toTitleCase fallback when set */
  label?: string;
}

/**
 * Maps clean tool names (after prefix-stripping) to display metadata.
 * Only built-in tools need entries here — MCP passthrough tools get their
 * titles from listTools and fall back to Atom02 / toTitleCase.
 */
export const TOOL_DISPLAY_MAP: Record<string, ToolDisplay> = {
  // VM file tools
  read: { icon: File06, label: "Read File" },
  write: { icon: Edit01, label: "Write File" },
  edit: { icon: Edit02, label: "Edit File" },
  grep: { icon: SearchMd, label: "Search Content" },
  glob: { icon: Folder, label: "Find Files" },
  bash: { icon: TerminalSquare, label: "Run Command" },

  // Agent / orchestration tools
  agent_search: { icon: Users03, label: "Search Agents" },

  // Resource / context tools
  read_tool_output: { icon: File06, label: "Read Tool Output" },
  read_resource: { icon: Database01, label: "Read Resource" },
  read_prompt: { icon: BookOpen01, label: "Read Prompt" },

  // System tools
  enable_tools: { icon: Tool01, label: "Enable Tools" },
  open_in_agent: { icon: Server01, label: "Open in Agent" },

  // Sandbox / code execution tools
  sandbox: { icon: Code02, label: "Run Code" },
  copy_to_sandbox: { icon: Download01, label: "Load File" },
  share_with_user: { icon: Upload01, label: "Share with User" },

  // Browser / web tools
  take_screenshot: { icon: Monitor01, label: "Take Screenshot" },
  scrape_url: { icon: Globe02, label: "Scrape URL" },
  inspect_page: { icon: Code01, label: "Inspect Page" },
};
