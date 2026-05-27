# Private Connections & Typed Slots — Design

**Status:** Draft
**Date:** 2026-05-27
**Author:** tlgimenes

## Motivation

Today every `mcp_connection` is org-scoped, and `downstream_tokens` stores at most one OAuth token per `connectionId` (migration `017-downstream-token-remove-userid.ts` deliberately consolidated to one token per connection). The result: whoever last completed the OAuth dance on a given connection owns the shared token used by every teammate.

For the GitHub MCP this surfaces a concrete bug: GitHub's `/user/installations` endpoint returns installations where the *authenticated user* has at least read access to a repo inside the installation's scope — which includes other teammates' personal-account installations when collaborator access exists. The "Import from GitHub" picker therefore displays teammates' personal accounts to the calling Studio user, mixing identities in a confusing and privacy-leaking way.

More broadly, the single-token model means *any* OAuth-backed downstream MCP shares identity across all org members. Teams need a way to keep most credentials private to the individual who minted them while still allowing intentional org-wide sharing where appropriate.

## Goals

1. Each user has their own credentials for downstream MCPs by default; teammates cannot accidentally use another person's identity.
2. Agents (virtual MCPs) remain shareable across the org even when they depend on private connections — they declare a *shape requirement* rather than a concrete connection.
3. Existing org-shared connections keep working through an explicit "shared" opt-in, with admin nudges to review.
4. Zero day-one breakage: production behavior is preserved at migration time.

## Non-Goals

- Replacing Better Auth's user/org model.
- Per-resource ACLs beyond the user/org binary.
- Allowing a user to maintain multiple connections of the same `app_id` in v1 (deferred — see "Future work").

## Concepts

### `access` on connections

`mcp_connection` gains a column:

```
access: 'user' | 'org'   NOT NULL  DEFAULT 'user'
```

- `user`: the connection is private to its `created_by`. Only that user can see it, edit it, or invoke tools through it.
- `org`: the connection is visible and usable by every member of the organization, with shared baked-in credentials.

A creator can **promote** `user → org` or **demote** `org → user`. Promotion is a deliberate "expose my credentials to my team" action. Demotion is destructive in the sense that it deletes the existing downstream token row (forces a fresh OAuth) so the previously-shared creds don't silently keep operating in a private context.

### Typed slots in agents

`connection_aggregation` (the join table between an agent and its child connections) gains:

```
slot_app_id: text NULL
```

with the XOR invariant:

```
CHECK ( (child_connection_id IS NOT NULL AND slot_app_id IS NULL)
     OR (child_connection_id IS NULL  AND slot_app_id IS NOT NULL) )
```

A row is either:

- **Concrete child** (`child_connection_id` set): resolves to that exact connection. Used for org-shared dependencies.
- **Slot** (`slot_app_id` set): resolves at runtime to the *caller's* connection of the matching `app_id`.

### R4: one private connection per shape per user

Partial unique index enforces:

```
UNIQUE (organization_id, created_by, app_id)
  WHERE access = 'user' AND app_id IS NOT NULL
```

Rationale: keeps v1 simple, makes slot resolution unambiguous. Power-user case (e.g., personal + side-org GitHub) is deferred to a future revision (see "Future work").

## Slot resolution

When an agent runs we walk its `connection_aggregation` rows. Concrete children resolve directly. Slots resolve dynamically given:

- `invokerUserId` — the user the run acts on behalf of.
  - **Interactive runs:** the authenticated caller.
  - **Trigger / automation runs:** the trigger's `created_by` (chosen rule "T1").
  - **API-key runs:** the API key's `userId`.
- `organizationId` — taken from the agent row, same as today.

Lookup SQL (one query per slot):

```sql
SELECT id FROM mcp_connection
WHERE organization_id = $organizationId
  AND app_id = $slot_app_id
  AND status = 'active'
  AND ( (access = 'user' AND created_by = $invokerUserId)
        OR (access = 'org') )
ORDER BY (access = 'user') DESC   -- prefer the invoker's private one
LIMIT 1;
```

The invoker's `user`-private connection wins. If they don't have one but an `org`-shared connection of the same shape exists, the run falls back to it. If neither exists, the resolver returns null and the agent run fails fast with a typed error:

```
SLOT_UNRESOLVED { app_id, slot_id }
```

The UI translates this into "Connect <App> to use this agent" with a deep-link to the connect flow.

**Cache:** resolution results are cached per `(agentId, invokerUserId)` for the duration of one agent run so all tools in a single run see a consistent set. Cache is per-run, not persistent; cross-run invalidation isn't needed.

**Observability:** each resolved slot writes OpenTelemetry attributes on the run span — `slot.app_id`, `slot.resolved_connection_id`, `slot.access` — so a teammate debugging a run can see whose credentials were used.

### Subtle implication

If Alice's agent has a `mcp-github` slot and Bob runs it but has no GitHub connection, the run **fails** even if Alice's private GitHub connection exists. Alice's credentials never substitute for Bob's. That is the entire point of slots; cross-contamination is the bug we're fixing.

## UI / tool surface changes

### Connection create/update

- `CONNECTION_CREATE` / `CONNECTION_UPDATE` accept an optional `access` field. Default `user`.
- Promote (`user → org`):
  - Allowed for `created_by` and org admins only.
  - Confirmation modal: *"Your <App> credentials will be used by every member of this org. Continue?"*
- Demote (`org → user`):
  - Allowed for `created_by` and org admins only. New owner is the demoter.
  - Confirmation modal: *"This will sign out the existing credentials. Members will need to reconnect. Continue?"*
  - In the same transaction, deletes the corresponding `downstream_tokens` row.

### Connection list UI

- Two tabs: **My connections** (default; user-private + all org-shared) and **Org-shared** (org rows only; promote/demote actions live here).
- Per-row badge: 🔒 *Private* or 🌐 *Shared*.

### Agent aggregator UI

- The child-picker dropdown shows:
  - The agent creator's own `user`-private connections (only when the agent is also private to the same creator).
  - All `org`-shared connections.
  - **Slot entries** — "Slot: any *AppName*" — one per known `app_id` in the workspace.
- Rules:
  - An `org`-shared agent can only have `org` children or slots.
  - A `user`-private agent can have its own creator's `user` children, `org` children, or slots.
  - Cross-user concrete children are never allowed.

### GitHub-import flow refactor

The bug-motivating UX. Two surfaces:

- `install-github-mcp-dialog.tsx` — entry point becomes a personal action. Creates a `user`-private mcp-github connection for the calling user (R4 prevents duplicates within a single user's connections).
- `github-repo-picker.tsx` — `InstallationPicker` no longer takes a `connectionId` prop. Before rendering, it calls a new helper tool:

```
CONNECTION_RESOLVE_FOR_USER({ app_id })
  → { connectionId } | null
```

  - App-only (`visibility: "app"`), not exposed to AI.
  - Returns the calling user's `user`-private connection of that shape (or null).
- If null → the picker renders the install dialog inline ("Connect your GitHub to import repos").
- If present → the picker calls `GITHUB_LIST_USER_ORGS({ connectionId })` with the resolved id.

Net effect: each user's picker shows only their own GitHub installations. The cross-contamination scenario disappears.

### Trigger / automation editor

- When the agent being scheduled has any slots, show a sticky banner: *"This will run as you (`<userlogin>`) — your <App> connection will be used."* Makes the T1 rule explicit at creation time.

### Org admin banner (M4 cleanup nudge)

- Org settings page shows: *"N connections are org-shared and may share credentials across all members. Review →"*
- One-time dismissible per admin (persisted in an existing settings/preferences table).
- Link goes to the org-shared tab.

## Schema changes (summary)

```
mcp_connection
+ access  text NOT NULL DEFAULT 'user'
  -- existing rows backfilled to 'org' (see Migration)

+ partial unique index (organization_id, created_by, app_id)
  WHERE access = 'user' AND app_id IS NOT NULL

connection_aggregation
+ slot_app_id  text NULL
  child_connection_id becomes nullable
+ CHECK ( (child_connection_id IS NOT NULL AND slot_app_id IS NULL)
       OR (child_connection_id IS NULL  AND slot_app_id IS NOT NULL) )
```

## Migration (M4 strategy)

Goal: no day-one breakage; bug fixed for new connections; admins steered toward cleanup.

1. Add `mcp_connection.access` with backfill: every existing row → `'org'`. After backfill, set the column DB default to `'user'` so new inserts that omit `access` get the private default.
2. Add `connection_aggregation.slot_app_id`, relax `child_connection_id` to NULL, add the XOR CHECK constraint.
3. Add the partial unique index. (Safe because all existing private rows are zero — backfill set everything to `'org'`.)
4. The runtime is untouched until Phase 2 ships. Schema-only PR.

## Rollout (five PRs)

Each phase is independently revertable. Phases 1 and 2 are invisible to users.

### Phase 1 — Schema

Just the migration above. No code reads the new columns yet.

### Phase 2 — Resolver + agent runtime

- New module `apps/mesh/src/core/slot-resolver.ts` implementing the SQL above.
- Wire it into the agent run path inside the existing aggregation walker.
- Emit OpenTelemetry attributes.
- Emit `SLOT_UNRESOLVED` typed error.
- Run-scoped resolution cache.
- No UI change. Agents with only concrete children are unaffected — the resolver short-circuits when `slot_app_id IS NULL`.

### Phase 3 — Connection UI surfaces

- Schema update on `CONNECTION_CREATE` / `CONNECTION_UPDATE` to accept `access`.
- Promote / demote tools and confirmation modals.
- Demotion deletes the `downstream_tokens` row in the same transaction.
- Connection list UI: tabs and badges.

### Phase 4 — GitHub-import refactor (bug fix lands)

- New app-only tool `CONNECTION_RESOLVE_FOR_USER`.
- `install-github-mcp-dialog` creates `user`-private mcp-github (R4-enforced).
- `github-repo-picker` resolves the caller's connection itself; the `connectionId` prop is removed.
- Regression test using two seeded GitHub OAuth fixtures so the cross-contamination scenario can't silently come back.

### Phase 5 — Admin nudges

- Org settings banner counting org-shared connections.
- Dismissible per admin via an existing settings/preferences row.

## Testing

### Storage layer

- Partial unique index: same user can have one `user`-private mcp-github but unlimited `org`-shared; org rows ignore the constraint; rows without `app_id` ignore the constraint.
- `connection_aggregation` XOR CHECK: can't set both, can't set neither.
- Demotion deletes the downstream token row inside the same transaction (assert both updates happen or neither does).

### Slot resolver

Table-driven tests over the resolver's pure-function behavior:

| Setup | Expected |
| --- | --- |
| User has private + org-shared of same `app_id` | resolves to private |
| User has only org-shared | resolves to org-shared |
| User has nothing | returns null (caller surfaces `SLOT_UNRESOLVED`) |
| Inactive connection | skipped |
| Connection in different org | not returned (cross-org leak guard) |

### Agent run integration

- Alice creates an org-shared agent with a `mcp-github` slot. Bob runs it with his own private mcp-github → uses Bob's creds (assert via tracing span / mock token).
- Bob runs the same agent with no mcp-github → fails with `SLOT_UNRESOLVED`; user-facing message renders correctly.
- Trigger fires the agent (owner = Alice) → resolves to Alice's creds, not the invoker's. Cover webhook and cron paths.
- Resolution cache invalidates when the user creates a new private connection mid-session.

### GitHub-import flow

- `CONNECTION_RESOLVE_FOR_USER` returns null when the caller has no matching private connection.
- `InstallationPicker` shows the install dialog instead of crashing when null.
- After the user installs, the picker re-queries and lists only the calling user's installations.
- Regression: two seeded GitHub OAuth fixtures (Alice's and Bob's) — assert Bob's picker never sees Alice's personal account.

### Migration

- M4 backfill test: seed mixed connections, run migration, assert all existing rows = `org`, new rows default to `user`.
- Promote-then-demote round trip: verify token row is gone after demotion.

### Resilience (optional / deferred)

- Scenario where the slot resolver's DB call times out mid-run; agent fails cleanly, not hangs.

## Risks & mitigations

- **Demotion is destructive.** Confirmation modal explains "behaves like a sign-out" and the audit log records the transition.
- **Promotion silently exposes creator's creds.** Confirmation modal spells out the exposure. Audit log records who promoted and when.
- **R4 surprises users who genuinely need two connections of the same shape.** Surfaces as a clear constraint violation referencing the docs; tracked as a known follow-up to relax to a "user-pinned default" rule.
- **Existing agents currently relying on cross-contaminated GitHub connections won't auto-migrate to slots.** Deliberate: owners decide whether each agent's child becomes a slot. The admin banner steers them; without action, the run continues using the org-shared connection.

## Success signals

- Count of `SLOT_UNRESOLVED` errors per week (adoption + UX health).
- Distribution of `mcp_connection.access` over time — expect `user` to dominate new rows within a couple of weeks.
- Zero reports of "I see a teammate's personal GitHub account in the import picker."

## Future work

- Relax R4 to a user-pinned default (R2): allow multiple `user`-private connections of the same `app_id`, with one marked as the default that slots resolve to.
- Per-agent slot overrides (R3) for power users who want different bindings per agent.
- Slot resolution preferences at the org level (e.g., "always require private; never fall back to org-shared").
