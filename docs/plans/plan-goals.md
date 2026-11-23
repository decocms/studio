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
and the Plan page opens on it. AI helps both ways: it **proposes several
goals** from what the company wrote and said, and it **detects duplicates**
when someone is about to create a goal that already exists, offering to use
that one instead. A business case, and later an automatic opportunity, is
always tied to one goal, so it reaches the people who use that goal.

## 4. Concepts

**Goal.** One sentence (keep the 280-char limit), plus:

- provenance: `created_by`, `updated_by`, timestamps, and optionally the
  `source` + `quote` it was found in (same shape `findBrandGoal` returns today)
- lifecycle: `archived_at`, `merged_into_id`

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
2. **Duplicate check before saving** (section 6.2). If a similar goal exists:
   "*Make the app our main sales channel in 2027* already exists (created by
   A. 3 weeks ago, used by 4 people). Use that one / Create mine anyway."
3. Save. The new goal becomes the member's active goal.

### 5.3 "Suggest goals with AI"

The existing finder is widened to return **several** candidates, each with a
quote and source. The UI shows them as a review list, and the member accepts,
edits or dismisses each one. Nothing is saved without a person accepting it
(same rule as today). Candidates that duplicate an existing goal are marked as
such instead of shown as new.

This also fixes the issue in #8599: suggestions never overwrite what the
person typed, because they are a separate list.

### 5.4 Business cases

- The composer shows the active goal as a chip ("Toward: Make the app our
  main sales channel ▾"), which the member can change for this case only.
- The case file stores `goal_id` **and** a snapshot of the statement. The
  snapshot keeps the case readable if the goal later changes, is merged, or is
  archived.
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

### 6.2 Duplicate detection and consolidation

Two moments:

1. **On create (synchronous, cheap).** Compare the new statement with every
   active goal in the organization. Use the fast model, or embeddings if we
   already have an embedding path, with a strict threshold. If it matches,
   offer "use existing" (make it the active goal) instead of creating. Never
   block: "create anyway" is always there.
2. **Consolidation proposals (async).** When two goals still end up saying the
   same thing (people skipped the prompt, or wording drifted), propose a merge
   to the people who created or use either one: "These 2 goals look like the
   same thing. Merge into: *…* (editable)". On accept:
   - the surviving goal keeps one statement, which a person approves;
   - the other gets `merged_into_id` and is hidden from the picker;
   - active goals, cases and opportunities pointing to the merged goal resolve
     to the survivor, and case snapshots stay unchanged.

Rule: **the AI proposes and a person decides.** No silent merges, because a
merge changes what other people's work is tied to.

### 6.3 Using goals downstream

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
  merged_into_id  text null -> plan_goals.id

member_plan_state
  user_id, organization_id               -- pk, cascade on both
  active_goal_id  text null -> plan_goals.id ON DELETE SET NULL
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
| `PLAN_GOAL_SIMILAR` | Duplicate check used by create (section 6.2). |
| `PLAN_GOAL_MERGE` | Applies an approved merge. |
| `PLAN_ACTIVE_GOAL_SET` | Writes only the caller's row. |
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
  else who wants different wording creates their own goal; the duplicate check
  shows them the existing one first. This keeps #8600's "last edit wins for
  everybody" from coming back.
- **Archive**: the creator, or `org:manage`. Archiving never touches cases
  (they keep their snapshot) and clears the active goal of whoever had it.
- **Merge**: the creator of either goal, or `org:manage`, always after a
  person approves the merged statement.
- Every query is scoped by organization, in storage and tools.

`ctx.access.check()` remembers the first grant
(`apps/api/src/core/access-control.ts`), so a second `check()` for
`org:manage` after the member check passes cannot deny anyone. The "creator or
admin" rule has to compare the caller with `created_by` and check the role
inside the handler.

## 9. Migration from the single goal

The migration follows the rollback rules in `apps/api/AGENTS.md`:

1. **Release A:** add the new tables. Backfill: each org with a non-null
   `plan_objective` gets one goal with the same statement,
   `created_by = updated_by`, timestamps copied, and it becomes the active
   goal of every member of that org, so nobody opens an empty Plan page. New
   code reads and writes goals. The old tool keeps working as a thin alias
   that updates that backfilled goal, so old clients and agent prompts don't
   break.
2. **Release B:** remove the alias tool, the `plan_objective` reads and
   `PlanObjectiveSchema`.
3. **Release C:** migration that drops `organization_settings.plan_objective`.

Existing case files keep their `objective` string. New cases also get
`goal_id`; the business-case schema gains an optional `goal` object
(`{ id, statement }`) and keeps reading old files.

## 10. Rollout

- New default-off org flag `plan_goals_enabled`, on top of `plan_page_enabled`
  (see `packages/shared/AGENTS.md#organization-flags`). Orgs without it keep
  today's single goal, backed by the backfilled goal row after release A.
- Phases:
  1. **Goal list + picker + active goal**: create, select, archive; business
     case tied to `goal_id`.
  2. **Suggest several goals with AI** (finder widened).
  3. **Duplicate check on create.**
  4. **Consolidation proposals + merge.**
  5. **Opportunity finder per goal** (separate plan).
- Analytics to decide if it works: goals per org, people per goal, % of cases
  tied to a goal, duplicate-prompt accept rate, merges proposed vs accepted.

## 11. Open questions

1. **Abandoned goals.** With no owner team, goals nobody uses will pile up.
   Archive automatically after N days with no active users and no new cases?
2. **Limit.** Max active goals per org (suggestion: 50), and what the picker
   and create flow do at the limit.
3. **Staleness.** Goals should probably carry a period ("in 2027") or a review
   date, with a nudge when one has expired.
4. **Conflicting goals** (e.g. "more volume" vs "fewer returns"). Should
   business cases surface conflicts with other goals as a risk card? Probably
   later.
5. **Multiple active goals per member?** v1 assumes one active goal with a
   per-case override.

## 12. Edge cases to cover in tests

- Empty: org with no goals; member with no active goal.
- Invalid: statement over 280 chars, statement that is only whitespace.
- Duplicate: same statement twice; same text with different case or
  punctuation.
- Oversized: an org at the goal limit; finder returning more candidates than
  allowed.
- Lifecycle: archive a goal that is some members' active goal; member leaves
  the org (goals they created stay, their `member_plan_state` row goes);
  merged goal referenced by old cases and by active goals; restoring an
  archived goal.
- Concurrency: two members creating the same goal at the same time (both pass
  the duplicate check, so consolidation catches it later); a merge while
  someone is writing a case against the losing goal.
- Authorization: a member who did not create a goal cannot edit or archive it;
  `PLAN_ACTIVE_GOAL_SET` cannot write another member's row.
