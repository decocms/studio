# Plan goals by area

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
  goal". With one goal it can only find opportunities for one area, and it
  can't send them to the right people.

The goal is the most important input of Plan, so it should model how
companies actually set goals: a company direction, plus goals per area, plus,
optionally, goals per person.

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

What the platform has, or lacks, for "areas":

- Better Auth's organization plugin runs with custom roles
  (`dynamicAccessControl`), but **teams are not enabled**. There is no
  team, department or job-area concept on members today.
- Roles are about permissions. Using them as "areas" would mix access with
  product grouping, which CLAUDE.md asks us not to do ("Feature flags gate
  product behavior, not access"; the same idea applies to roles).
- Personal space already exists in the org filesystem (`users/<userId>/…`,
  used by daily briefs), so "a member's own" is an established idea.

## 3. Proposal in one paragraph

Replace the single goal with a **list of goals**. Each goal has a **scope**:
the whole company, an area (Marketing, Returns, Checkout…), or one person.
Areas are a small, org-owned list (not auth teams, not roles). Each member
**follows** the areas they work in. The Plan page opens on **the goal the
member is working toward** (picked from a select), with the option to create a
new one. AI helps both ways: it **proposes goals grouped by area** from what the
company wrote and said, and it **detects duplicates** when someone creates a
goal that already exists, offering to join it instead. A business case, and
later an automatic opportunity, is always tied to one goal, so it reaches the
people who follow that goal's area.

## 4. Concepts

**Goal.** One sentence (keep the 280-char limit), plus:

- `scope`: `organization` | `area` | `personal`
- `area_id` (required when scope is `area`)
- `owner_user_id` (required when scope is `personal`)
- provenance: `created_by`, `updated_by`, timestamps, and optionally the
  `source` + `quote` it was found in (same shape `findBrandGoal` returns today)
- lifecycle: `archived_at`, `merged_into_id`

**Area.** An org-owned label such as "Marketing" or "Returns & CX". It is
deliberately small: `id`, `name`, optional `description`. It exists so that
"Marketing" and "marketing team" are one thing, so goals and opportunities can
be grouped, and so it can be renamed in one place.

**Following.** A member follows zero or more areas. Following decides:

- which goals show first in the member's picker
- which opportunities (future) and business cases the member is shown or
  notified about

**Active goal.** Per member, the goal the Plan page opens on. It is a
preference, not a permission.

Not proposed: an org chart, a hierarchy of goals (OKR-style parent/child), or
numeric key results. Those can come later. The first version only needs
grouping and routing.

## 5. UX

### 5.1 Plan page header: goal picker instead of a single sentence

```
YOUR GOAL ▾  [Marketing] Make the app our main sales channel in 2027
             ─────────────────────────────────────────────────────
             Company
               • Grow online revenue 30% in 2027
             Marketing (you follow)
               • Make the app our main sales channel in 2027   ✓
               • Lower CAC on paid social
             Returns & CX
               • Cut return rate on apparel below 12%
             Personal
               • (yours only) Test 3 new creative formats per month
             ─────────────────────────────────────────────────────
             + New goal        ✦ Suggest goals with AI
```

- Areas the member follows come first; the others stay reachable (people do
  plan across areas) but further down.
- The selected goal is what gets sent to the business case composer under it.
- The empty state (no goals at all) keeps today's "write it, or find it with
  AI" flow, which ends by creating the first `organization` goal.

### 5.2 Creating a goal

1. The member writes the sentence and picks a scope: Company / an area (from
   the list, or "+ new area") / Just me. The default is the first area they
   follow, or Company if they follow none.
2. **Duplicate check before saving** (section 6.2). If a similar goal exists:
   "Marketing already has *Make the app our main sales channel in 2027*
   (created by A. 3 weeks ago). Use that one / Create mine anyway."
3. Save. The new goal becomes the member's active goal.

### 5.3 "Suggest goals with AI"

The existing finder is widened to return **several** candidates, each with a
suggested area, quote and source. The UI shows them as a review list, and the
member accepts, edits or dismisses each one. Nothing is saved without a
person accepting it (same rule as today). Candidates that duplicate an
existing goal are marked as such instead of shown as new.

This also fixes the issue in #8599: suggestions never overwrite what the
person typed, because they are a separate list.

### 5.4 Following areas

- A light first-visit step on Plan: "Which areas do you work on?" with the
  org's areas as chips (multi-select, skippable).
- Changeable later from the picker ("Areas you follow") and from the member's
  profile.
- Admins can see which areas have no followers and no goals.

### 5.5 Business cases

- The composer shows the active goal as a chip ("Toward: Make the app our
  main sales channel ▾"), which the member can change for this case only.
- The case file stores `goal_id` **and** a snapshot of the statement and the
  area name. The snapshot keeps the case readable if the goal later changes,
  is merged, or is archived.
- "Your business cases" can filter by goal and by area. Seeing the cases of
  an area you follow (not only your own) becomes possible; today the list only
  shows cases you created (`plan-cases-list.tsx`).

## 6. AI parts

### 6.1 Finding goals by area

Extend `findBrandGoal` instead of writing a second finder:

- Output: up to N candidates (e.g. 6), each `{ statement, area_name, quote,
  source }`. Keep the evidence check (`checkProposal`: the quote must really be
  in something that was read) and the Jev direction check
  (`acceptDirection`) per candidate.
- Give it the org's existing areas and goals so it can (a) map a candidate to
  an existing area, (b) suggest a new area only when nothing fits, and (c)
  skip what already exists.
- Same budget and timeouts as today; more candidates must not mean more
  reading.

### 6.2 Duplicate detection and consolidation

Two moments:

1. **On create (synchronous, cheap).** Compare the new statement with the
   goals in the same scope/area (and with company goals). Use the fast
   model, or embeddings if we already have an embedding path, with a strict
   threshold. If it matches, offer "use existing" (follow/select it) instead
   of creating. Never block: "create anyway" is always there.
2. **Consolidation proposals (async).** When two goals in the same area
   still end up saying the same thing (people skipped the prompt, or wording
   drifted), propose a merge to the people involved: "These 2 goals look like
   the same thing. Merge into: *…* (editable)". On accept:
   - the surviving goal keeps one statement, which a person approves;
   - the other gets `merged_into_id` and is hidden from pickers;
   - cases and opportunities pointing to the merged goal resolve to the
     survivor, and their snapshots stay unchanged;
   - each creator becomes a follower/contributor of the survivor, so nobody
     "loses" their goal.

Rule: **the AI proposes and a person decides.** No silent merges, because a
merge changes what other people's work is tied to.

### 6.3 Using goals downstream

- Business case prompt: include goal + scope + area name ("Marketing goal:
  …") instead of the bare sentence. The skill can then pick metrics that
  match the area.
- Automatic opportunity finder (future): runs **per goal**. An opportunity is
  stored with its `goal_id` and is shown to the followers of that goal's area
  (or the owner, for personal goals). Company goals reach everyone, but they
  should rank below the goals of the areas a member follows, or company goals
  will drown out the per-area ones.

## 7. Data model (sketch)

New tables via Kysely migration (`268-plan-goals.ts` or the next free
number). Everything is scoped by `organization_id` and removed with the org.

```
plan_areas
  id            text pk
  organization_id text not null
  name          text not null          -- unique per org, case-insensitive
  description   text null
  created_by    text not null
  created_at, updated_at
  archived_at   timestamptz null

plan_goals
  id            text pk
  organization_id text not null
  scope         text not null          -- 'organization' | 'area' | 'personal'
  area_id       text null  -> plan_areas.id
  owner_user_id text null              -- personal goals only
  statement     text not null          -- <= 280
  source_label  text null
  source_quote  text null
  created_by, updated_by text not null
  created_at, updated_at
  archived_at   timestamptz null
  merged_into_id text null -> plan_goals.id
  CHECK (scope = 'area') = (area_id IS NOT NULL)
  CHECK (scope = 'personal') = (owner_user_id IS NOT NULL)

plan_area_followers
  organization_id, area_id, user_id    -- pk (area_id, user_id)

plan_member_preferences            -- or a column on an existing per-member table
  organization_id, user_id, active_goal_id
```

Shared Zod schemas live in `packages/shared` (next to `PlanObjectiveSchema`,
which this replaces), and storage adapters go under `apps/api/src/storage/`.

### Tools

| Tool | Notes |
| --- | --- |
| `PLAN_GOAL_LIST` | Goals visible to the caller, with area and follow info. |
| `PLAN_GOAL_CREATE` / `PLAN_GOAL_UPDATE` / `PLAN_GOAL_ARCHIVE` | Author and time come from the session, as today. |
| `PLAN_GOAL_SIMILAR` | Duplicate check used by create (section 6.2). |
| `PLAN_GOAL_MERGE` | Applies an approved merge. |
| `PLAN_AREA_LIST` / `CREATE` / `UPDATE` / `ARCHIVE` | |
| `PLAN_AREA_FOLLOW` / `UNFOLLOW`, `PLAN_ACTIVE_GOAL_SET` | |
| `ORGANIZATION_PLAN_OBJECTIVE_FIND` | Widened to multiple candidates (section 6.1); probably renamed `PLAN_GOAL_SUGGEST`. |

Agent built-in (`plan-tools.ts`): replace `ORGANIZATION_PLAN_OBJECTIVE_SET`
with `PLAN_GOAL_CREATE`/`UPDATE`, keeping the rule that an agent saves only a
sentence the person approved in the chat.

### Realtime

Org settings have no push path today (`saved-store-goal.ts` works around it
with a refetch). Goals in their own table should use the standard path in
`apps/api/AGENTS.md#realtime-delivery`:

- `PLAN_GOALS_UPDATED_EVENT` (and maybe `PLAN_AREAS_UPDATED_EVENT`) in
  `packages/shared`
- emitted via `sseHub.emit` from a helper next to the storage writes
- added to `WATCH_TYPES` in `watch-sse-pool.ts`

Then `saved-store-goal.ts` and its refetch can be deleted.

## 8. Authorization and privacy

Proposed defaults (open for discussion in section 11):

| Action | Company goal | Area goal | Personal goal |
| --- | --- | --- | --- |
| See | all members | all members | owner only |
| Create | members with `org:manage`, or any member? (open) | any member | owner |
| Edit / archive | creator + `org:manage` | creator, area followers?, `org:manage` | owner |
| Merge | `org:manage` | creator of either goal, or `org:manage` | n/a |

- Personal goals must never appear in another member's picker, in the
  duplicate check results shown to others, or in the "suggest" input for
  others. The duplicate check runs only over goals the caller can see.
- The finder already skips `users/` (personal homes). Keep that.
- Every query is scoped by organization **and** by the visibility rules
  above, enforced in storage/tools, not only hidden in the UI.

## 9. Migration from the single goal

The migration follows the rollback rules in `apps/api/AGENTS.md`:

1. **Release A:** add the new tables. Backfill: each org with a non-null
   `plan_objective` gets one `organization`-scope goal with the same
   statement, `created_by = updated_by`, timestamps copied. New code reads
   and writes goals. The old tool keeps working as a thin alias that
   updates that one company goal, so old clients and agent prompts don't
   break.
2. **Release B:** remove the alias tool, the `plan_objective` reads and
   `PlanObjectiveSchema`.
3. **Release C:** migration that drops `organization_settings.plan_objective`.

Existing case files keep their `objective` string. New cases also get
`goal_id`; the business-case schema gains an optional `goal` object
(`{ id, statement, scope, area_name }`) and keeps reading old files.

## 10. Rollout

- New default-off org flag `plan_goals_enabled`, on top of `plan_page_enabled`
  (see `packages/shared/AGENTS.md#organization-flags`). Orgs without it keep
  today's single goal, backed by the same company-goal row after release A.
- Phases:
  1. **Goals + areas + picker** (no AI changes): create, select, follow,
     archive; business case tied to `goal_id`.
  2. **Suggest goals by area** (finder widened).
  3. **Duplicate check on create.**
  4. **Consolidation proposals + merge.**
  5. **Opportunity finder per goal** (separate plan).
- Analytics to decide if it works: goals per org and per area, % of members
  following ≥1 area, % of cases tied to an area goal vs a company goal,
  duplicate-prompt accept rate, merges proposed vs accepted.

## 11. Open questions

1. **Who may create company goals?** Any member (fast, risk of noise) or
   `org:manage` only (clean, slower adoption)?
2. **Areas: free-form or curated?** Any member can create an area, or admins
   curate the list? Free-form plus duplicate detection on area names is the
   lighter option.
3. **Should areas become Better Auth teams later?** That would let areas also
   drive access (e.g. connections per team). Recommended: not now. Keep areas
   as a product concept and revisit if access per area becomes a real need.
4. **Personal goals in v1?** They add privacy rules and UI. They could ship
   after area goals.
5. **Multiple active goals per member?** v1 assumes one active goal with
   per-case override.
6. **Conflicting goals across areas** (e.g. Marketing "more volume" vs
   Returns "fewer returns"). Should business cases surface conflicts with
   other areas' goals as a risk card? Probably later, but it's an argument for
   always passing company goals to the case agent too.
7. **Staleness.** Goals should probably carry a period ("in 2027") or a review
   date, with a nudge when one has expired.
8. **Limits.** Max areas per org, goals per area, and personal goals per member,
   to avoid unbounded picker lists (suggestion: 30 / 10 / 5).

## 12. Edge cases to cover in tests

- Empty: org with no goals and no areas; member who follows nothing.
- Invalid: area goal without area, personal goal without owner, statement over
  280 chars, statement that is only whitespace.
- Duplicate: same statement twice in the same area; same text with different
  case or punctuation; two area names that differ only in case.
- Oversized: an org at the goal/area limits; finder returning more candidates
  than allowed.
- Lifecycle: archive an area that still has goals (archive them too, or
  block?); member leaves the org (their personal goals are deleted; area
  goals they created stay); merged goal referenced by old cases; restoring an
  archived goal.
- Concurrency: two members creating the same goal at the same time (both pass
  the duplicate check, so consolidation catches it later); a merge while
  someone is writing a case against the losing goal.
- Visibility: personal goals never leak through list, similar, suggest, case
  lists or SSE payloads to another member.
