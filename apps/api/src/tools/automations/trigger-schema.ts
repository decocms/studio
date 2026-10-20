import { z } from "zod";

export const AutomationTriggerTypeSchema = z.enum([
  "cron",
  "event",
  "webhook",
  "board_column_transition",
  "board_pr_ready",
  "linked_chat_run",
  "board_pr_merged",
  "chat_pr_opened",
  "jira_transition",
]);

// tools is an allowlist of tool names, stored as JSON text; bound it.
const TOOLS_ALLOWLIST_MAX_ENTRIES = 200;
const TOOLS_ALLOWLIST_MAX_STRING_LENGTH = 200;

export const ToolsAllowlistSchema = z
  .array(z.string().max(TOOLS_ALLOWLIST_MAX_STRING_LENGTH))
  .max(TOOLS_ALLOWLIST_MAX_ENTRIES);
