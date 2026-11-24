# Plan goals

Status: proposal, not implemented. This document is for discussion before any
code changes. Section 11 lists the decisions that are still open.

## 1. Problem

The Plan page has a single **store goal** per organization: one sentence that
everyone sees and that is sent with every business case. In a small team that
works. In a larger company it does not:

- A social media marketer and the returns / customer-satisfaction team are
  working toward different things. A single company-wide sentence is either
  too vague to help either of them or relevant to only one.
- Any member can overwrite the one goal, so the last person to edit it wins
  for everybody (see #8600 for the "Clear goal" case).
- The goal is meant to drive more than business cases. The planned
  **automatic opportunity finder** will look for improvements "toward the
  goal". With one goal it can only look in one direction, and it can't send
  what it finds to the right people.

## 2. Today (what the code does)

| Piece | Where | Notes |
| --- | --- | --- |
| Storage | `organization_settings.plan_objective` (jsonb), migration `267-org-plan-objective.ts` | `{ statement, updated_by, updated_at }`, one per org, max 280 chars (`PLAN_OBJECTIVE_MAX_LENGTH`). |
| Schema | `packages/shared/src/organization/schema.ts` → `PlanObjectiveSchema` | |
| Write | `ORGANIZATION_PLAN_OBJECTIVE_SET` (`apps/api/src/tools/organization/plan-objective-set.ts`) | Member-writable (not `org:manage`). `null` clears it. Also given to agents as a built-in (`harnesses/decopilot/built-in-tools/plan-tools.ts`). |
| Find with AI | `ORGANIZATION_PLAN_OBJECTIVE_FIND` → `findBrandGoal` (`plan-goal-find.ts`, `plan-goal-evidence.ts`, `plan-goal-connections.ts`, `plan-goal-direction.ts`) | Reads org memory, uploaded text files and connections. Returns **one** statement with a quote and source, checked by Jev. Skips `plans/`, `skills/`, `users/`. |
| UI | `apps/web/src/components/plan/plan-objective.tsx` | Edit, clear, find. |
| Consumers | `business-case-prompt.ts` (prompt text), `case-seed.ts` and `packages/shared/src/business-case.ts` (`objective: string \| null` copied into the case file) | The case stores a **copy** of the text, not a reference. |
| Freshness | `saved-store-goal.ts` | Org settings have **no push path**. The chat refetches settings after a turn that wrote the goal. |
| Gate | `plan_page_enabled` org flag | |

## 3. Proposal in one paragraph

Replace the single goal with a **list of goals** that belongs to the
organization. Any member can add a goal, and any member can use one. There is
no area, team or scope to pick: whoever needs a goal writes it, and whoever
shares it picks it. Each member chooses **the goal they are working toward**,
and the Plan page opens on it. AI **proposes several goals** from what the
company wrote and said. A business case, and later an automatic opportunity, is
always tied to one goal, so it reaches the people who use that goal.

## 4. Concepts

**Goal.** One sentence (keep the 280-char limit), plus:

- provenance: `created_by`, `updated_by`, timestamps, and optionally the
  `source` + `quote` it was found in (same shape `findBrandGoal` returns today)
- lifecycle: `archived_at`

**Active goal.** Per member, the goal the Plan page opens on. It is a
preference, not a permission.

**People who use a goal.** The members whose active goal it is, plus the
members who created a business case toward it. This set replaces any notion
of teams: it decides who sees a goal's cases and, later, who is told about its
opportunities.

Not proposed: areas, teams, an org chart, a hierarchy of goals (OKR-style
parent/child), or numeric key results. Those can come later if grouping by
goal turns out not to be enough.

## 5. UX

### 5.1 Plan page header: goal picker instead of a single sentence

```
YOUR GOAL ▾  Make the app our main sales channel in 2027
             ─────────────────────────────────────────────────────
             🔍 Search goals
             Yours
               • Make the app our main sales channel in 2027   ✓
               • Test 3 new creative formats per month
             Used in your organization
               • Grow online revenue 30% in 2027        · 9 people
               • Cut return rate on apparel below 12%   · 3 people
               • Lower CAC on paid social               · 2 people
             ─────────────────────────────────────────────────────
             + New goal        ✦ Suggest goals with AI
```

- **Yours**: goals you created or have used. **Used in your organization**:
  the rest, ordered by how many people use each one and how recently cases
  were written toward it.
- The search field appears once the list has more than about 10 goals.
- The selected goal is what gets sent to the business case composer under it.
- The empty state (no goals at all) keeps today's "write it, or find it with
  AI" flow, which ends by creating the first goal.

### 5.2 Creating a goal

1. The member writes the sentence. Nothing else to fill in.
2. Save. The new goal becomes the member's active goal.

### 5.3 "Suggest goals with AI"

The existing finder is widened to return **several** candidates, each with a
quote and source. The UI shows them as a review list, and the member accepts,
edits or dismisses each one. Nothing is saved without a person accepting it
(same rule as today). Candidates that repeat a goal the organization already
has are left out.

This also fixes the issue in #8599: suggestions never overwrite what the
person typed, because they are a separate list.

### 5.4 Business cases

- The composer starts the case toward the member's goal. A chip to change it
  for one case only ("Toward: Make the app our main sales channel ▾") can come
  later; switching the goal in the picker covers it for now.
- The case file keeps the snapshot of the statement it has today
  (`objective`), which stays readable if the goal later changes or is
  archived. Which goal a case went toward is stored in `plan_goal_cases`,
  not in the file: the agent rewrites the case file and could drop a field it
  does not know.
- "Your business cases" can filter by goal. Seeing other members' cases
  toward the **same goal** becomes possible; today the list only shows cases
  you created (`plan-cases-list.tsx`).

## 6. AI parts

### 6.1 Suggesting goals

Extend `findBrandGoal` instead of writing a second finder:

- Output: up to N candidates (e.g. 6), each `{ statement, quote, source }`.
  Keep the evidence check (`checkProposal`: the quote must really be in
  something that was read) and the Jev direction check (`acceptDirection`) per
  candidate.
- Give it the org's existing goals so it can skip what already exists.
- Same budget and timeouts as today; more candidates must not mean more
  reading.
- The single store-goal finder (`ORGANIZATION_PLAN_OBJECTIVE_FIND`, for orgs
  without goals) asks for one candidate, so Jev still checks one goal.

### 6.2 Using goals downstream

- Business case prompt: send the selected goal's sentence, as today.
- Automatic opportunity finder (future): runs **per goal**. An opportunity is
  stored with its `goal_id` and is shown to the people who use that goal.

## 7. Data model (sketch)

New tables via Kysely migration (`268-plan-goals.ts` or the next free
number). Everything is scoped by `organization_id` and removed with the org.

```
plan_goals
  id              text pk
  organization_id text not null -> organization (cascade)
  statement       text not null          -- <= 280, not blank
  source_label    text null
  source_quote    text null
  created_by, updated_by text not null
  created_at, updated_at
  archived_at     timestamptz null

member_plan_state
  user_id, organization_id               -- pk, cascade on both
  active_goal_id  text null -> plan_goals.id ON DELETE SET NULL

plan_goal_cases
  organization_id, thread_id             -- pk; org cascade
  goal_id         text not null -> plan_goals.id
  user_id         text not null
  created_at
```

`member_plan_state` has the same shape as `user_sidebar_preferences`
(migration `230-project-sidebar.ts`), but with a real foreign key so deleting
a goal clears it. Shared Zod schemas live in `packages/shared` (next to
`PlanObjectiveSchema`, which this replaces). New storage classes go on
`StudioStorage` in `apps/api/src/core/studio-context.ts`, like the sprints and
alerts storage.

### Tools

| Tool | Notes |
| --- | --- |
| `PLAN_GOAL_LIST` | Active goals, with usage counts and whether the caller created or used each. |
| `PLAN_GOAL_CREATE` / `PLAN_GOAL_UPDATE` / `PLAN_GOAL_ARCHIVE` | Author and time come from the session, as today. |
| `PLAN_ACTIVE_GOAL_SET` | Writes only the caller's row. |
| `PLAN_GOAL_CASE_RECORD` / `PLAN_GOAL_CASES` | Ties a case chat to its goal; lists the cases toward a goal. |
| `PLAN_GOAL_SUGGEST` | Replaces `ORGANIZATION_PLAN_OBJECTIVE_FIND`, widened to several candidates (section 6.1). |

Agent built-in (`plan-tools.ts`): replace `ORGANIZATION_PLAN_OBJECTIVE_SET`
with `PLAN_GOAL_CREATE` and `PLAN_ACTIVE_GOAL_SET`, keeping the rule that an
agent saves only a sentence the person approved in the chat.

### Realtime

Org settings have no push path today (`saved-store-goal.ts` works around it
with a refetch). Goals in their own table should use the standard path in
`apps/api/AGENTS.md#realtime-delivery`, the same way sprints do
(`apps/api/src/tools/task-board/sprints.ts`,
`apps/web/src/hooks/use-task-board-sprints.ts`):

- `PLAN_GOALS_UPDATED_EVENT` in `packages/shared`
- emitted via `sseHub.emit` from a helper next to the storage writes
- added to `WATCH_TYPES` in `watch-sse-pool.ts`

Then `saved-store-goal.ts` and its refetch can be deleted.

## 8. Authorization

- **See, create and use** a goal: any member.
- **Edit the sentence**: the member who created it, or `org:manage`. Anyone
  else who wants different wording creates their own goal. This keeps #8600's "last edit wins for
  everybody" from coming back.
- **Archive**: the creator, or `org:manage`. Archiving never touches cases
  (they keep their snapshot) and clears the active goal of whoever had it.
- Every query is scoped by organization, in storage and tools.

`ctx.access.check()` remembers the first grant
(`apps/api/src/core/access-control.ts`), so a second `check()` for
`org:manage` after the member check passes cannot deny anyone. The "creator or
admin" rule has to compare the caller with `created_by` and check the role
inside the handler.

## 9. Migration from the single goal

The migration follows the rollback rules in `apps/api/AGENTS.md`:

1. **Release A:** add the new tables. No backfill: the first goal list read
   of an org with no goals at all seeds one goal from `plan_objective`, with
   the same statement, author and time. Orgs keep writing the single goal
   until they turn goals on, so seeding at that point starts from their latest
   text. A member who never picked a goal opens on the org's oldest open goal,
   which is the seeded one, so nobody opens an empty Plan page. Orgs without
   the flag keep `ORGANIZATION_PLAN_OBJECTIVE_SET` unchanged; with it, agents
   get the goal tools instead.
2. **Release B:** once every org is on goals, remove
   `ORGANIZATION_PLAN_OBJECTIVE_SET` / `_FIND`, the `plan_objective` reads and
   `PlanObjectiveSchema`.
3. **Release C:** migration that drops `organization_settings.plan_objective`.

Case files keep their `objective` string, old and new; the business-case
schema does not change.

## 10. Rollout

- New default-off org flag `plan_goals_enabled`, on top of `plan_page_enabled`
  (see `packages/shared/AGENTS.md#organization-flags`). Orgs without it keep
  today's single goal.
- Phases:
  1. **Goal list + picker + active goal**: create, select, archive; business
     cases tied to their goal in `plan_goal_cases`.
  2. **Suggest several goals with AI** (finder widened).
  3. **Opportunity finder per goal** (separate plan).
- Analytics to decide if it works: goals per org, people per goal, % of cases
  tied to a goal, suggestions accepted vs dismissed.

## 11. Open questions

1. **Abandoned goals.** With no owner team, goals nobody uses will pile up.
   Archive automatically after N days with no active users and no new cases?
2. **Limit.** Max active goals per org (suggestion: 50), and what the picker
   and create flow do at the limit.
3. **Staleness.** Goals should probably carry a period ("in 2027") or a review
   date, with a nudge when one has expired.
4. **Repeated goals.** Nothing stops two members from writing the same goal
   in different words. Detecting and merging them was left out of this
   version; revisit if the picker fills with repeats.
5. **Conflicting goals** (e.g. "more volume" vs "fewer returns"). Should
   business cases surface conflicts with other goals as a risk card? Probably
   later.
6. **Multiple active goals per member?** v1 assumes one active goal with a
   per-case override.

## 12. Edge cases to cover in tests

- Empty: org with no goals; member with no active goal.
- Invalid: statement over 280 chars, statement that is only whitespace.
- Repeated: the same statement twice is allowed; suggestions skip a goal the
  org already has, despite case or punctuation.
- Oversized: an org at the goal limit; finder returning more candidates than
  allowed.
- Lifecycle: archive a goal that is some members' active goal; member leaves
  the org (goals they created stay, their `member_plan_state` row goes);
  restoring an archived goal.
- Concurrency: two members creating goals at the limit at the same time; a
  goal archived while someone starts a case toward it.
- Authorization: a member who did not create a goal cannot edit or archive it;
  `PLAN_ACTIVE_GOAL_SET` cannot write another member's row.
