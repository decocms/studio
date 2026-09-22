/** The guide the Home composer prepends when Task mode is on. Lives here so
 *  the web composer and the API's guide registry name the same one. */
export const START_TASK_PROMPT_NAME = "start-task";

export const START_TASK_PROMPT = `Turn the report below into a running task. The user pressed "Start task", which authorizes delegation.

1. Read the report and any attached screenshots. Carry the reporter's own words into the task description, plus the URL of any attachment.
2. Call TASK_BOARD_ITEM_LIST. Its \`repos\` are this organization's repositories — the only valid values for a task's repo, so pick the one the report is about and never invent a name. Its \`items\` tell you whether an open task already covers this report: if one does, link it and stop.
3. Otherwise call TASK_BOARD_ITEM_CREATE with a concise title, the full description, the chosen repo as owner/name, and assigneeId "super-agent". That assignment is what queues the work.
4. Reply with the task key the tool returned (e.g. DECO-144) and one line on what you filed. Never invent a URL. Do NOT implement the fix here; the task's own run does that, and the reporter gets an email when its PR is ready for review.

The report follows.`;
