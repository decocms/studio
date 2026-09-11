/** The guide the Home composer prepends when Task mode is on. Lives here so
 *  the web composer and the API's guide registry name the same one. */
export const START_TASK_PROMPT_NAME = "start-task";

export const START_TASK_PROMPT = `Turn the report below into a running task. The user pressed "Start task", which authorizes delegation.

1. Read the report and any attached screenshots. Keep the original details and attachment URLs in the task description.
2. Call REPOSITORY_LIST and pick the repository the report is about. Never invent a repository name — if the choice is genuinely unclear, ask one focused question before creating the task.
3. Call TASK_BOARD_ITEM_LIST to check whether an open task already covers this. If one does, link it and stop.
4. Otherwise call TASK_BOARD_ITEM_CREATE with a concise title, the full description, the chosen repo as owner/name, and assigneeId "super-agent". Do not set a status — assigning the Super Agent queues the work.
5. Reply with the task link and one line on what you filed. Do NOT implement the fix here; the task's own run does that, and the reporter gets an email when its PR is ready for review.

The report follows.`;
