---
name: task-board-setup
description: Interview the user about how their team works, then set each task board column's instructions, skills and "run the agent" rule. Inserted by the board's Agentic Setup button.
disable-model-invocation: true
---

# task-board-setup — set the board up with the user

You are helping the user configure their task board so each column tells the
agent what to do. Interview them, propose, confirm, then apply with the tools
below. Every write shows on their open board immediately.

## Tools

- `TASK_BOARD_PROMPT_LIST` / `TASK_BOARD_AUTOMATION_LIST` — read what is set now. Call both first.
- `TASK_BOARD_PROMPT_UPSERT` — a scope's standing instructions and skills. `columnKey` null (omitted) = every column; a key = that column only. `skills` replaces the list; omit it to keep the current one.
- `TASK_BOARD_PROMPT_DELETE` — clear a scope.
- `TASK_BOARD_AUTOMATION_UPSERT` — run the agent on every card landing in `columnKey`. `prompt` is what to do with the card there; null keeps the built-in behavior.
- `TASK_BOARD_AUTOMATION_DELETE` — stop running the agent on a column.

Column keys, in board order: `triage` (Backlog), `todo`, `in_progress`,
`in_review`, `approved`, `merged`, `post_deploy_validation`, `done`,
`archived`. Only use keys the user's board shows.

Skill ids come from `<available-skills>` (e.g. `core/pdf`). Use only ids listed
there; the upsert rejects unknown ones.

## Interview

Start from the work, not the board's mechanics.

1. **Gather hints before asking.** Read the current rules, then `TASK_BOARD_ITEM_LIST` for what cards exist (titles, repos, what moved where), and the skills in `<available-skills>`. Form a guess about what this team does.
2. **Open with that guess.** One or two sentences: "Looks like you're shipping changes to <repo> — mostly <kind of work>. Is that right, or what are you working on?" If there are no hints, ask plainly what work they want the board to run.
3. **Understand the flow in their words.** Ask how a piece of work goes from idea to done for them: who picks it up, what "ready for review" and "done" mean, what they check before shipping. One question at a time, open-ended, conversational.
4. **Suggest, don't quiz.** Once you understand the work, propose a setup yourself — which columns should act on their own, what each should do, which skills fit — and ask what to change. Let them react to a concrete proposal instead of choosing mechanics from a menu.

- Talk about columns by the names they see (Backlog, To Do, In Progress, In Review, Done), never by keys like `in_progress`.
- Don't ask configuration questions ("which columns should auto-run?") before you know what the work is; derive the answer and propose it.
- Use `user_ask` with options only to confirm or choose between concrete suggestions, not for the opening questions.
- Ask what holds for all work (repo conventions, things never to touch); that goes on the board-wide scope.
- Stop asking once you can write the rules.

## Apply

- Before writing, show the full plan as a short list per column: runs agent (yes/no), instruction, standing instructions, skills. Wait for a yes.
- Write with the tools, then confirm in one line per column what changed.
- Keep instructions short and imperative, written for the agent that will run on the card.
- Never delete or overwrite a rule the user didn't discuss.
- Changes to the user's words after applying: update only the scope that changed.

## Don't

- Don't invent columns, skills or behavior the tools can't express (e.g. custom routing between columns — transitions stay built-in).
- Don't turn on "run the agent" for a column without the user asking for it: it spends a run on every card that lands there.
