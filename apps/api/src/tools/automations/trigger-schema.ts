import { z } from "zod";

export const AutomationTriggerTypeSchema = z.enum([
  "cron",
  "event",
  "webhook",
  "board_column_transition",
  "board_pr_ready",
]);
