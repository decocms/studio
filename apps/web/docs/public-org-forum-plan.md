# Public org + forum plan

Status: forum slice built (see below) · Owner: Gui · Branch: `gui/public-org-plan`

## Built so far

Built on the project-first navigation (#7532, the **New Layout** preference):
projects are the channels, and the forum is a lens on the board.

- **Org:** "Deco Builders", slug `/builders`.
- **Data:** `task_board_items.project_id` and `task_board_item_votes`
  (migration 227). A card filed in a project carries `projectId`, and the
  board attributes it to that project. A channel is a project with
  `metadata.forum` (`visibility`, `kinds`); topic kinds are org tags.
- **Tools:** `FORUM_CHANNEL_LIST`, `FORUM_TOPIC_LIST`, `FORUM_TOPIC_GET` and
  `FORUM_TOPIC_VOTE`. Topics are created with `TASK_BOARD_ITEM_CREATE`
  (`projectId`) and replied to with the card comment tools.
- **Web:** the board has a fourth view, **Threads** (Feed · Threads · Board ·
  List), with Hot / New / Top / Unanswered and kind chips. A forum project
  opens on Threads, and an open topic replaces the list. The org-wide Tasks
  board's Threads view spans every channel.
- **Seed:** `apps/api/scripts/seed-builders.ts` creates `/builders` with
  Roadmap, Jobs & Bounties, Open to Work and Help, synthetic members, topics,
  replies and votes.
- **Not built yet:** unread counts on sidebar projects, and everything in P0
  steps 1–3, 6 and 8 (the `community` role, open join, author checks, join
  screen), and P1 onward. Until the role exists, only invite a trusted group:
  members still get the `user` role.

## Why

We want to replace Discord (a chat room: realtime, noisy, rewards whoever has
infinite time) with a **forum**: important topics surface, people read a
thoughtful discussion and add their point, async-first. Most discussions end
in something an agent or a person has to do, so **a forum topic is a task
card**, and the forum is one more way to look at the board.

First use: one public deco org anyone can sign up for and join. Two forums:

1. **Roadmap**: product discussions, proposals, what's planned and shipped.
2. **Jobs**: roles, bounties, freelance gigs, and people offering their work
   (profiles and CVs). The goal is to move the people who implement AI in
   enterprise digital experiences: they find work, find each other, get hired.

## What Studio already has (and what's missing)

Most of the forum already exists on **task-board cards**, not on threads:

| Need | Exists today | Gap |
|---|---|---|
| Topic with many human authors | Card + `task_board_comments` (1 level of replies, `author_id`, edit/delete own, resolve) — `apps/api/src/tools/task-board/comments.ts` | — |
| @mentions, follow, inbox, email digest | `packages/shared/src/mentions.ts`, `notifications/notify.ts`, `notification_subscriptions` (per card), `dbos-digest.ts` | no @agent trigger |
| Status lifecycle | Lanes (`tools/task-board/lanes.ts`), free-text `status` column | lanes are org-wide, not per project |
| Categories | Tags (`task_board_item_tags`) | — |
| Voting, "hot" ranking | — | missing |
| Card belongs to a project (channel) | — (cards have `repository_id`, no project) | missing |
| Anyone can join an org | Domain auto/request join only; generic emails rejected (`tools/organization/domains.ts:246`) | missing open join |
| Read-only / limited member | Built-in `owner/admin/user`; `user` gets `agents:manage`, `connections:manage`, sandbox, fs write (`packages/shared/src/tools/registry-metadata.ts:1563,1983`); `BASIC_USAGE_TOOLS` is added to **every** role at runtime (`apps/api/src/core/access-control.ts`) | no limited role possible |
| Public projects | Project allowlist on custom roles (`packages/shared/src/auth/project-scope.ts`) | no per-project visibility |
| Per-member cost / abuse limits | Model allowlist per role only; auth rate limit effectively off (`auth/index.ts:519`) | missing |

Threads (chats) stay what they are: one person working with an agent. They are
not the forum. They can't be: only the creator can post
(`decopilot/dispatch-run.ts:1017`), and messages don't record an author.

## Model

- **Public org**: an org with `join_mode = "open"`. Any signed-in user can join
  with one click and gets the `community` role.
- **Forum = project**. Each forum is a project with `visibility = "public"` and
  a `forum` preset. Projects are the channels. Sidebar folders group them, as
  elsewhere in Studio.
- **Topic = task card** with `project_id` set. Replies are comments. The
  **Threads** lens (forum) and the **Board** lens (kanban) show the same cards.
- **Topic kinds** per forum, as card `type` plus a description template:

| Forum | Kinds | Lanes (per project) |
|---|---|---|
| Roadmap | proposal · question · announcement | proposed → planned → in progress → shipped · declined |
| Jobs | role · bounty · gig · profile | open → claimed / interviewing → in review → done / filled · closed |

- A **bounty** is a card with acceptance criteria. "Claim" sets the claimer as
  assignee and moves it to *claimed*. Payment happens outside Studio (v1).
- A **profile** is one card per member in Jobs (headline, skills, rate,
  availability, links). The lanes are *available* and *busy*. It's also what
  their People entry shows.
- **Roadmap ↔ internal work**: a roadmap card can link to an internal task in
  `decocms` (`external_url` / `external_key`). When that task ships, the public
  card moves to *shipped*. The public never sees internal discussion.

## Access

| Can a `community` member… | v1 |
|---|---|
| See public projects and their cards, comments, votes | yes |
| Create topics and comments, vote, follow, @mention | yes (rate limited) |
| Edit / delete own topics and comments | yes |
| Claim a bounty | yes |
| See non-public projects, members' emails, settings, billing | no |
| Chat with agents, start sandboxes, create connections or projects, write to org fs | no |
| Trigger `@deco` | no in v1 (moderators only), capped daily quota in v2 |

Moderators are org `admin`s. They can edit, move, lock, pin and delete any
topic, and ban members.

## UX

**Joining**
1. `studio.decocms.com/<org>` for a non-member shows a landing page: what the
   org is, its public forums with topic counts, the latest topics, and a
   **Join** button. That replaces "no access" in `OrgAccessGate` when the org
   is open.
2. Sign up or log in, then one click to join. First run asks you to pick
   interests (tags) and offers to create your profile card ("Open to work?").

**Sidebar (community member)**
- Inbox · Roadmap · Jobs · People. No Agents, Connections, Library or Settings.
- A forum row turns bold on unread activity, with a count, like channels
  elsewhere.

**Threads view** (a board layout, `?view=threads`, default for forum projects)
- Tabs: **Hot** · **New** · **Top** · **Unanswered**, plus chips for kinds and
  tags.
- Each row shows: kind badge, title, author, votes, reply count, last activity,
  lane pill, and "✦ summary" when deco has written a TL;DR.
- **New topic** opens a composer with the kind's template (a role asks for
  company, stack, remote/on-site, budget; a bounty asks for scope, acceptance
  criteria, reward, deadline).
- A **Board** toggle shows the same cards as a kanban. For Roadmap, that's the
  public roadmap.

**Topic page** (`/$org/projects/$agentId/forum/$key`)
- Original post, then the deco **TL;DR** kept current as the discussion moves,
  then replies (comments with one level of nesting).
- Actions: ▲ vote, Follow, Share, and for kind-specific actions **Claim**
  (bounty) or **Apply / Contact** (role, profile). Moderators also get lane
  change, pin, lock and "link internal task".
- A status timeline comes from `task_board_activity`.

**People** is a member directory built from profile cards (skills, availability,
rate), with filters.

**Home** for a public org: new this week, hot topics, open bounties, new
profiles, and shipped roadmap items.

## Implementation

### P0: join, role, visibility, forum list (flag `community_mode`)

Everything is behind a new org flag `community_mode` in `OrgFlagsSchema`
(`packages/shared/src/organization/schema.ts:157`). The access fixes below also
apply without the flag.

1. **Basic usage per role.** Change `AccessControl` so `BASIC_USAGE_TOOLS` is
   granted by role instead of to everyone. `owner/admin/user` behave exactly as
   today. This unblocks any limited role. (`core/access-control.ts`,
   `auth/builtin-role-permission.ts`)
2. **`community` built-in role** in `packages/shared/src/auth/roles.ts`, with an
   explicit allowlist: task list/get/create/update-own, comments, votes,
   subscriptions, notifications, `USER_GET`, member list (name and avatar only).
   No sandbox, fs write, connections, agents or decopilot.
3. **Open join.** Add `join_mode: "invite" | "request" | "open"` to org settings
   (a column in `organization_settings`, default `invite`). Add
   `POST /api/auth/custom/open-join/:slug` next to `domain-join`
   (`api/routes/auth.ts:347`): it requires a verified email, adds the member
   with role `community`, and is idempotent. Extend
   `GET /org-access-status/:slug` with `can-join-open`.
4. **Project visibility.** Add `metadata.visibility: "org" | "public"`
   (default `org`) in `packages/shared/src/sdk/types/virtual-mcp.ts`. The
   project-scope filter (`apps/api/src/core/project-scope.ts`) limits
   `community` to `visibility = public`. Also fix the scope leak in
   `VIRTUAL_MCP_LAST_USED_LIST`.
5. **Cards belong to projects.** Migration: `task_board_items.project_id`
   (nullable, indexed, FK to the connection id). `TASK_BOARD_ITEM_LIST`
   filters by `projectId`, and for `community` it is **forced** to public
   projects. The same check covers get, comment and subscribe.
6. **Author checks.** Only the author (or an admin) can update or delete a card
   or comment. Also fix the existing gap where any member can rename or delete
   another member's thread (`tools/thread/update.ts:69`, `delete.ts:72`).
7. **Forum view.** Add a `forum` value to `sidebarViews` (`virtual-mcp.ts:142`),
   plus routes and components in `apps/web`: list, composer with templates,
   topic page reusing the card comment components. Add i18n keys in
   `i18n/en` and `i18n/pt-br`.
8. **Join screen.** Add an `open-join` screen to `OrgAccessGate` with the
   landing content described above.

### P1: surfacing and safety

9. **Votes.** Table `task_board_item_votes(item_id, user_id, created_at)` with
   primary key `(item_id, user_id)`, and a `TASK_BOARD_ITEM_VOTE` tool
   (toggle). Hot score = votes + recent replies, decaying with age; compute it
   in the list query.
10. **Per-project lanes.** `metadata.board.lanes` overrides the org lanes for
    that project (Roadmap and Jobs presets). Unknown statuses fall back to the
    first lane.
11. **Rate limits.** Per member per day, e.g. 10 topics, 100 comments, 200
    votes, counted in the DB and set in org settings. Joins are throttled per
    IP. Limits are skipped for admins.
12. **Report and moderate.** A "Report" action adds a `flagged` activity and
    puts the topic in a moderator queue (a view on the Inbox). Also: lock (no
    new comments), pin, and ban (remove the member and block rejoin).
13. **@deco summaries, moderator-triggered.** A TL;DR is written as a pinned
    comment by `super-agent` and refreshed on request. The cost goes to the
    org's AI wallet. Use a cheap model.

### P2: reach and marketplace

14. **Logged-out read-only pages** for public projects (SEO, sharing), rendered
    server-side like `/report/$domain` (`api/routes/report-pages.tsx`). They
    show no emails or profile contact details.
15. **People directory** built from profile cards. Also a **Claim** flow for
    bounties and **Contact** for roles (a DM thread between two members, which
    also serves as the DM model).
16. **Roadmap ↔ internal task sync**: when a linked `decocms` task reaches
    done, the public card moves to shipped.
17. **@deco quota for members**, e.g. 3 questions per day, answered in-topic
    and billed to the org. Spam screening of new topics runs as a sacred
    automation (cheap model; flagged topics go to moderation).

### P3

18. Full-text search over topics and comments (`GLOBAL_SEARCH` only matches
    titles today). "Who's here now" presence on topics. Push notifications.

## Tests

- **E2E** (`packages/e2e`), sign up with a generic email and join an open org,
  then check that:
  - only public projects are visible;
  - posting a topic, commenting and voting work;
  - sandbox, connections, org fs write, decopilot and settings are denied.
- **Access unit tests**: each denied tool for `community`, and `owner/admin/user`
  unchanged after the basic-usage refactor.
- **Author checks**: editing or deleting someone else's card, comment or
  thread is denied for non-admins.
- **Rate limits**: at the limit, over the limit, and the admin bypass.
- **Join**: a duplicate join doesn't error, a banned member can't rejoin, and
  an org that isn't open returns the current access-status answers.

## Rollout

1. Ship P0 behind `community_mode`, with the access fixes on for everyone.
2. Create the public org and its two forums (Roadmap, Jobs), seed them with
   ~10 real topics each, and invite 30 people from our network.
3. Measure weekly: returning members, topics that got ≥3 replies, time to
   first reply, bounties claimed, and roles filled.
4. Discord goes read-only with a pinned link once the forum has one month of
   activity.

## Open questions

- **Logged-out reading:** in v1 (better reach) or P2 (simpler)?
- **Profiles:** visible to members only, or public?
- **Bounty payouts:** do we ever hold or pay money through Studio, or does it
  stay outside?
- **@deco for members:** is the org paying (daily cap), or members' own wallets?
