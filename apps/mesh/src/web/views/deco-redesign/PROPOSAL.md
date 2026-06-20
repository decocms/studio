# Proposal: the personal home (`/me`) — a user-centric layer above orgs

## Problem

Studio is **always** org-scoped. On `main`, the root route `/` immediately
redirects you into your first org (`listOrganizationsCached() → firstOrg →
/$org`). There is no place that is simply **you**. You can't see all your
projects at a glance, and you can't talk to deco without first picking an org.

But the person is the root entity. An org is a *context you enter*. When I open
deco I'm talking to my teammate that helps me across many projects — decocms,
anjo.chat, tama, mangabeira — each its own org, with its own members. I should
land in **my** space, see everything I have access to, and drop into a project
when I want to work on it.

## Model

```
YOU ─┬─ decocms     (org) ─ agents, members, loops
     ├─ anjo.chat   (org) ─ agents, members, loops
     ├─ tama        (org) ─ ...
     └─ mangabeira  (org) ─ ...
```

The person is root. Each project is an org you're a member of. `/me` is the
layer where *you* live; entering a project drops into `/$org`. Primary unit in
the cockpit = **projects (orgs)**, expandable to the agents inside each.

## Where it lives

Two layers — one mostly exists, one is the real work.

**1. Route / UX (exists on this branch).** `/me` is mounted under `rootRoute`,
above any org, and `/` redirects to it. Rendered in the same shell chrome as an
agent. This is the `rafavalls/product-redesign` scaffold — **this PR is stacked
on it** because it's the fastest base (the `/me` view already exists).

**2. Cross-org data layer (does NOT exist — the work).** The backend is
deliberately hard org-scoped: `createOrgScopedApi`, the `resolveOrgFromPath`
middleware, cross-org isolation enforced and tested (404 on any cross-org read).
The only above-org primitive is Better Auth's `listOrganizations(user)`.

The right shape is a **fan-out aggregator, not a god-scope** — it never bypasses
isolation, it just iterates the user's own memberships and merges:

```
/api/me/*  (personal scope)
  └─ for each org in listOrganizations(user):
       call that org's existing scoped endpoints
       (agents, last-used, pending tasks/inbox, automation runs, findings)
  └─ aggregate + rank
```

For the MVP this can even run **client-side** (most users have a handful of
orgs), then move server-side for caching once it matters.

## The home is a chat (this PR)

The home today is a passive dashboard whose "New task" button just fires a
toast. This PR makes the home **conversational**: the hero is a composer — the
org-less "talk to deco" surface — so you can ask about anything across your
projects before entering one. Quick-prompt chips replace the old static
"Suggestions" grid.

What's wired here: the composer UI (`HomeChat` in `personal-home.tsx`), with
`⌘/Ctrl+Enter` to send. What's stubbed: submit toasts instead of opening a
thread — because the backend below is the next step.

## The four elements of `/me` (priority order)

1. **Teammates rail** — your projects/agents across all orgs, each with a
   liveness dot. Click → enter `/$org`. `⌘K` to jump to any project. *(sidebar
   exists; wire to `listOrganizations` fan-out instead of `mock-user`.)*
2. **Talk to deco** — the org-less composer (this PR). Backed by a personal
   Decopilot thread that can answer "how's everything doing," route you into a
   project, or spin up a new one (create org).
3. **Needs-you queue** — the single cross-project list: pending approvals,
   failures, regressions. **This is where the per-loop morning email lands
   in-app.**
4. **Project updates** — per-org 24h digest (loop summaries, deploys, metric
   deltas). Reuse the tile board from `new-home` / `restore-home-dnd-ux`.

## Why this matters beyond the home

`/me` is the cockpit for **all your loops across all projects**; the org-level
Studio is the cockpit for one project's loops. Same product, two zoom levels.
The "Needs-you" queue *is* every loop's morning email, aggregated. Build `/me`
and the loops vision gets its natural home.

## Build sequence (low-hanging first)

1. **Land `/me`** — route + `PersonalHome` shell + chat composer. *(this PR)*
2. **Teammates rail → real data** — replace `mock-user` with a client-side
   fan-out over `listOrganizations` + `agent-last-used-info`. *Fixes the core
   complaint on its own; ~days.*
3. **Org-less "talk to deco" thread** — a personal Decopilot thread; submit in
   `HomeChat` opens/streams it. Later: cross-org routing + "create project."
4. **Needs-you queue** — aggregate pending tasks/inbox + failed automation runs
   + findings across orgs (reuse `home-next-actions.ts` per org).
5. **Project updates tiles** — per-org 24h digest.

## Notes

- Stacked on `rafavalls/product-redesign` (fastest base; `/me` lives there).
  Can be rebased onto `main` with the `/me` route cherry-picked if we want it to
  land independently.
- `personal-home.tsx` is still backed by `mock-user.ts`. Steps 2–4 swap mock for
  the fan-out aggregator. No backend isolation is weakened — `/api/me/*` only
  ever reads the user's own org memberships.
