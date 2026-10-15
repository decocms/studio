import { z } from "zod";

export const AutomationTriggerTypeSchema = z.enum([
  "cron",
  "event",
  "webhook",
  "board_column_transition",
  "board_pr_ready",
  "jira_transition",
]);

const TRIGGER_PARAMS_MAX_ENTRIES = 50;
const TRIGGER_PARAMS_MAX_STRING_LENGTH = 2000;

export const TriggerParamsSchema = z
  .record(
    z.string().max(TRIGGER_PARAMS_MAX_STRING_LENGTH),
    z.string().max(TRIGGER_PARAMS_MAX_STRING_LENGTH),
  )
  .refine(
    (params) => Object.keys(params).length <= TRIGGER_PARAMS_MAX_ENTRIES,
    {
      message: `params can have at most ${TRIGGER_PARAMS_MAX_ENTRIES} entries`,
    },
  );
