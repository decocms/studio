# Studio — design doc

**Date:** 2026-05-27
**Status:** Draft, shareable

How we see Studio. The product, its primitives, how they work for the user.

---

## What Studio is

The operating layer for AI-driven enterprise storefronts. The customer logs in, finds their storefront already there, with a chat to ask for changes, a familiar CMS to edit content, and agents running on their behalf — checking page speed, watching for errors, validating releases, surfacing where they're losing conversion.

We sell outcomes, not licenses. A team operates the storefront for the first months; the product captures what was learned; over time more of the work runs autonomously. The product, from the customer's view, *is* the agents. The platform underneath is how we deliver them.

---

## The mental model

A small vocabulary:

- **Org** — where you and your team work.
- **Agent** — anything you can talk to. Your storefront is an agent. PageSpeed is an agent. Gmail is an agent. Everything in your sidebar is an agent.
- **Skill** — a reusable instruction packet an agent can call on. Visible in each agent's settings; FDEs and power users write and import them.
- **Task** — a chat with an agent. Some end in a couple of turns; some become longer pieces of work with a state (in review, merged, archived).
- **Automation** — an agent running on its own, on a schedule or triggered by an event.
- **Findings** — what agents report back when they notice something worth your attention — overnight, or during a task.
- **Files** — anything that gets created or uploaded. Each one has an owner and an access list.

That's it. Everything in the product is one of these. How an agent connects to an outside service (OAuth, API key, MCP) is internal plumbing — not a concept the user needs to hold.

---

## The primitives

### Org

The container your team works in. Members share its agents and its files (subject to access). One org per company is the typical shape. Agencies have several.

### Agent

Anything addressable in your sidebar — something you can open, chat with, and assign work to. Three flavors users encounter:

- **Your storefront.** Rich. Has its own UI (the Agentic CMS) with content editing, a pages browser, a chat panel, and a findings panel.
- **A specialist.** PageSpeed, SEO, QA, System Health. Focused. Runs on its own. Reports findings. You rarely open one directly — you encounter their output first (see *How agents surface*).
- **An integration.** Gmail, GitHub, Shopify. Thin. A wrapper around an outside service. You can chat with it directly ("Gmail, triage unread suppliers") and other agents in the org can call its tools too.

Same shape under the hood. Different surfaces.

**Private connections.** By default, a connection to an outside service is org-level — any agent in the org can use it. You can mark a connection as *private*, scoping it to a specific agent with dedicated token slots. The credentials are never shared with other agents or sites in the same org.

### Skill

A reusable instruction packet an agent can call on — "how to write a PDP description", "how to triage a 500 error", "how to validate a release". Skills live at the org level (shared by every agent) or at the agent level (specific to one).

Skills are visible. Each agent's settings shows its active skills. FDEs and power users import, write, and configure them. End users don't write skills, but they see their effect — a suggestion style, a triage behavior, a formatting convention.

### Task

A chat with an agent. The same primitive whether it's a quick question or a long piece of work. When it produces work — a proposed change, a PR, a report — it carries state: *in review*, *merged*, *rejected*, *archived*.

A task can span multiple PRs. You keep prompting after the first merge; the next request becomes the next PR under the same task. Merged is a milestone, not the end.

### Automation

An agent running without you.

- **Scheduled** — every weekday at 9am, run PageSpeed across the top pages.
- **Triggered** — when a 500 spike happens, run the diagnostic and propose a fix.

You don't watch them run. You see what they produced — usually a finding, sometimes a task with a proposed PR.

### Findings

The way agents report. A finding is whatever the agent thinks deserves your attention — a PageSpeed regression, a 500 spike System Health caught, a conversion drop, a suggestion mid-task.

Each finding is a card: what was found, what's proposed, one clear next action. Findings live with the agent that produced them, but aggregate into the home digest so you see the cross-cutting picture without opening every agent.

### Files

Anything that exists: an uploaded banner, an agent-generated report, a slide, a PDF, a screenshot.

Every file has an *owner* (person or agent) and an *access list*. The defaults:

- **You make a file** → private to you.
- **An agent makes a file** → visible to everyone on the agent's team.

The user thinks in views, not paths: *My files · Shared with me · Files of agent X · Org-wide*. Same filesystem, filtered.

---

## How the Home works

### The org pilot

The home chat talks to the org's pilot — an agent with visibility across the entire org. It's not a chatbot; it's a router and executor in one.

Per turn, it does one of three things:

- **Executes in place.** Small asks (a quick lookup, a summary, a fetch from a connected tool) get answered inline. No handoff.
- **Delegates to another agent as a sub-task.** When it needs a specialist's tools, it calls that agent in the background. The call shows as a collapsed line in the Home thread, expandable for detail.
- **Proposes opening a task elsewhere.** When the work deserves its own surface — multi-turn, ongoing, producing something to review — the pilot returns a card: *"This looks like work for PageSpeed. Open it there?"* One click to open. The user is never yanked away — they choose.

The user can always override: *"no, just answer here"* → the pilot tries inline instead.

When the pilot can't route with confidence, it asks. It does not silently guess.

**Discoverability.** Starter prompts under the input give new users a few entry points. A *"what can I do here?"* affordance is always present. Both collapse or fade once the user is comfortable.

### The digest: findings, tasks, automations

Below the chat: a grid of tiles. The user pins what they want. Three are always available:

**Findings** — a digest of what agents surfaced since you last looked. Cross-cutting: PageSpeed's regressions, System Health's errors, QA's validation results, all on one screen. Clicking a card opens it in the agent that found it. This is the magical moment — you arrive, and the work has already been done.

**Tasks** — open work across your agents. Active, in review, merged-but-continuing. Automations appear as their own row type: recurring entries with run history collapsed underneath. Click a run → conversation transcript + execution trace side by side.

**Automations** — a status summary of scheduled and triggered runs: last run, next run, green/red. Click to manage, pause, re-run, or fork.

### Routing heuristic

The pilot's routing follows from the nature of the ask:

| Ask type | Pattern |
|----------|---------|
| Quick lookup, summary, calculation | In place |
| Needs a specialist's tools (run SEO check, send an email) | Sub-task to that agent |
| Multi-turn work, produces an artifact, has a review state | Propose opening a task in the right agent |

---

## How agents surface

The specialist agents — QA, System Health, Performance, SEO — are not something users find by browsing a catalog. They surface through what they produce.

**Contextually in the storefront.** When editing a page, the page bar shows signals from agents watching that page — page views in the last 24h, average latency, cache health. Green or red, not raw numbers. Click to go deeper. The agent is already running; you encounter its output in context, where it's relevant.

**Through the findings tile.** Most of what specialists produce lands here. You see the finding before you think about which agent produced it. Clicking reveals the source and any proposed action.

**Through a task.** When a triggered automation fires — a 500 spike, a failed release validation — it surfaces as a task in your queue. You open it; the agent explains what it found and proposes a next step.

The design principle: agents earn their place in the product through their output. They don't ask to be discovered — they show up when they have something worth showing.

---

## The surfaces

### Home

Where you arrive. Chat in the center, digest tiles below. The pilot handles routing; the tiles surface what needs attention.

### Storefront agent

The Agentic CMS:

- **Site preview** — live view of the storefront.
- **Pages browser** — a list of all pages organized by template type (Home, PLP, PDP, Checkout, My Account, etc.). The content hub: where you go to find and edit any piece of the site.
- **CMS forms** — structured editing for the selected page or section.
- **Chat panel** — talk to the storefront agent directly. Ask for changes, get explanations, kick off tasks.
- **Findings panel** — findings relevant to this storefront, surfaced inline.
- **Assets browser** — org-level files the storefront can use.

### Specialist agent

Its dashboard: what it watches, what it found, when it last ran. Navigation into findings and automations. Rarely the user's first entry point — they typically arrive here from a finding or a task.

### Integration agent

Minimal. A chat to address it directly, plus connection settings and scope management.

### Tasks panel

Open tasks across all agents. Active, in review, merged. Click to open the transcript with whatever the task produced — preview, diff, file. Automations have their own row type.

### Settings

Members, roles, branding, AI provider keys, SSO. Per-agent settings (skills, connection scopes, automation schedules) live with the agent.

---

## What it feels like in the morning

You sign in. The Home loads. The Findings tile shows three items — PageSpeed caught two regressions overnight, System Health flagged a 500 spike, QA validated last night's release. A Tasks tile has one PR from yesterday waiting on your review. The Automations tile shows last night's runs all green. You scan, click the most important finding, approve the proposed fix. Less than five minutes from open to action.

The work has already been done. You're reviewing and steering, not driving from zero. That's the bet.

---

## UX principles we're betting on

**One product, one chrome.** No "inside" mode. Switching agents changes the context, not the chrome.

**Magical, not reactive.** The product is already doing things when you arrive. The chat is one way to engage, not the only way.

**One primitive.** Storefronts, specialists, integrations — all agents. Same rules, different surfaces.

**Agents surface before you go looking.** Specialists earn their place through output: findings, inline signals, tasks. The user discovers them through value, not navigation.

**Files default by who made them.** Private when a human creates them, shared with the agent's team when an agent creates them. The user doesn't need to be taught it.

**Vertical depth.** We're storefronts-first in 2026. Other domains come from learning, not speculation.

**Cross-agent transparency.** When one agent calls another, the user sees it as a collapsed line in the task. Expandable for detail. Visible by default, never noise.

**Defer instead of dabble.** No public marketplace, no embedded panels, no white-label, no cross-org operator views in 2026. Each one is interesting; none ships without a real customer asking.

---

## The filesystem we're converging toward

How everything is laid out under the hood. One tree per org. Each agent is a folder. Connections are folders too. AGENTS.md files carry the configuration.

```
/orgs/<org-id>/
  AGENTS.md                    ← org-wide instructions, loaded by every agent
  skills/                      ← org-wide skills
  artifacts/                   ← org-wide shared files

  agents/
    <agent-slug>/
      AGENTS.md                ← agent config + instructions
      memory.json              ← agent persistent memory
      skills/                  ← agent-specific skills
      artifacts/               ← agent-generated files
      automations/             ← agent automations
      ...                      ← freeform, or git worktrees per branch

  connections/
    <connection-slug>/
      mcp.json                 ← connection metadata (no secrets)
```

Two cases for an agent folder, decided by whether `AGENTS.md` has a `github:` property in its frontmatter:

**Plain agent.** Freeform workspace. The agent can write to `artifacts/`; everything else (its instructions, memory, skills) is read-only at runtime — only humans change those through the UI or the repo.

```
agents/support-triage/
  AGENTS.md
  memory.json
  skills/
  artifacts/
    2026-05-13-summary.md
  automations/
  data.csv
```

**GitHub agent.** Linked to a repo. Child folders are git worktrees, one per branch. The agent starts inside the active branch's folder and can write freely there.

```
agents/web-developer/
  AGENTS.md                    ← has `github:` in frontmatter
  memory.json
  skills/
  artifacts/
  automations/
  main/                        ← worktree for main branch
    src/
  feature-checkout-flow/       ← worktree for a feature branch
    src/
  fix-login-bug/               ← worktree for a fix branch
    src/
```

Sharing happens through git: commit to your branch, open a PR to `main`. A human reviews and merges. `main` is the canonical published store.

---

## Design questions and answers

### 1. Home chat — what prompts, what routing?

Talking to Home talks to the org's pilot. Per turn, it chooses one of three patterns:

- a. **In place.** Small asks (a number, a summary, a quick fetch) answered inline.
- b. **Sub-task to another agent.** When it needs a specialist's tools, it calls that agent in the background. The call shows as a collapsed line in the Home thread, expandable.
- c. **Proposes opening a task elsewhere.** When the work deserves its own surface, the pilot returns a card. The user chooses — they're never yanked away.
- d. User can always override: *"no, just answer here"* → pilot tries inline.
- e. When the pilot can't route with confidence, it asks rather than guessing.

Discoverability: starter prompts + a persistent *"what can I do?"* affordance. Both fade as the user gets comfortable.

### 2. Just-in-time provider connection (Gmail mid-conversation)

- a. Agent attempts the action → fails because the connection is missing → shows an inline card asking for it. No detour to a settings page.
- b. OAuth opens in a new tab. Agent auto-continues on return — the user doesn't have to re-send.
- c. Connections are org-level by default. The user can opt to scope it to themselves (personal) or mark it private to a specific agent with dedicated token slots.
- d. Scope upgrades (read-only → send) use the same inline card flow, not a separate prompt.
- e. Decline → agent tries an alternative or fails cleanly. Never leaves the user stuck silently.
- f. Every connection event is audit-logged: who consented, what scope, on whose behalf, when.

### 3. Post-merge task lifecycle

- a. States: proposed → in-progress → awaiting-review → merged | rejected → archived.
- b. Merged is a milestone, not terminal. Keep prompting in the same task → next PR under the same task.
- c. Branch deleted on merge; worktree torn down.
- d. Revert spawns a linked task. Hotfix can be a follow-up or a new task.
- e. Auto-archive 30 days idle post-merge, with undo.
- f. Archived tasks stay searchable; threads become read-only; artifacts persist.

### 4. Automations in the tasks panel

- a. Distinct row type — recurring entries with run history collapsed under them.
- b. Click a run → conversation transcript + execution trace side by side.
- c. Inline pause and re-run; detail view for edit, cancel, fork.
- d. Per-run logs: inputs, prompt, tools called, side effects, cost.
- e. Failures: red status in the panel + notification; 3× retry with backoff by default.
- f. Side effects attributed to the agent (the principal); automation shown as the trigger in audit.

### 5. Artifact visibility across agents

- a. Every file has an owner principal (person or agent) and an access list.
- b. Human-created → private. Agent-created → shared with the agent's collaborators.
- c. Cross-agent access by explicit handoff — pass a file reference in a tool call.
- d. Artifact survives the task that produced it; lives with its owner.
- e. Edits in-place with audit log; latest writer wins.
- f. Provenance recorded per artifact (run + prompt + tools that produced it).

### 6. Sandbox mounting

- a. One mutable `/workspace/` per sandbox, scoped to a task.
- b. Files fetched lazily via signed URLs; outputs egress via explicit save tool calls.
- c. Sub-agents get read-only access to parent's files; no cross-agent shared mount.
- d. 1 GB cap per run; larger outputs must chunk or stream.
- e. Secrets never on disk; passed as env vars at process start, scoped per tool.
- f. External providers (Google Drive, S3 elsewhere) accessed via tool calls, not FS mounts.
