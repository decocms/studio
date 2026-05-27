# Studio — design doc

**Date:** 2026-05-27
**Status:** Draft, shareable

How we see Studio. The product, its primitives, how they work for the user.

For the engineering view see [`system-design.md`](./system-design.md). For the strategy see [`product-vision.md`](./product-vision.md).

---

## What Studio is

The operating layer for AI-driven enterprise storefronts. The customer logs in, finds their storefront already there, with a chat to ask for changes, a familiar CMS to edit content, and a set of agents running on their behalf — checking page speed, watching for errors, validating releases, surfacing where they're losing conversion.

We sell outcomes, not licenses. A team operates the storefront for the first months; the product captures what was learned; over time more of the work runs autonomously. The product, from the customer's view, *is* the agents. The platform underneath is how we deliver them.

---

## The mental model

A small vocabulary:

- **Org** — where you and your team work.
- **Agent** — anything you can talk to. Your storefront is an agent. PageSpeed is an agent. Gmail is an agent.
- **Connection** — an agent that wraps an outside service. Lives in your sidebar like any other agent. You can chat with it; other agents can use it.
- **Skill** — a reusable instruction packet an agent can call on. Mostly invisible to end users; FDEs and power users write them.
- **Task** — a chat with an agent. Some end in a couple of turns; some become longer pieces of work with a state (in review, merged, archived).
- **Automation** — an agent running on its own.
- **Findings** — what agents report back when they find something — overnight, or during a task.
- **Files** — anything that gets created or uploaded. Each one has an owner and an access list.

That's it. Everything in the product is one of these.

---

## The primitives

### Org

The container your team works in. Members share its agents, its connections, and its files (subject to who's been given access). One org per company is the typical shape. Agencies have several.

### Agent

Anything addressable in your sidebar — something you can open, chat with, and assign work to. Three flavors users encounter:

- **Your storefront.** Rich. Has its own UI (the Agentic CMS) with content editing, a chat panel, and a findings panel. Its assets and other files live at the org level — the agent works on them but doesn't own them.
- **A specialist.** PageSpeed, SEO, QA, Reliability. Focused. Runs on its own. Reports findings.
- **An integration.** Gmail, GitHub. Thin. Mostly tools wrapped around an outside service. You can chat with it directly ("Gmail, triage unread suppliers") and other agents in the org can use its tools too.

Same shape under the hood. Different surfaces.

### Connection

**A connection is an agent that wraps an outside service** — Gmail, GitHub, your analytics, your CDN. You set it up once (OAuth + scopes). From then on it lives in your sidebar like any other agent. Two things you can do with it:

- **Open it and chat directly.** *"Gmail, find unread emails from suppliers."* The connection answers using its own tools.
- **Let other agents use it.** Your storefront can call Gmail's tools through a single inline approval in chat. No second OAuth, no setup ritual.

Same primitive as any other agent. Just thinner — it doesn't carry instructions or memory beyond what the wrapped service provides.

### Skill

A small, reusable instruction packet an agent can call on — "how to write a PDP description", "how to triage a 500 error", "how to format a finding". Skills live at the org level (shared by every agent) and at the agent level (specific to one). Most users never write skills directly; they're authored by the internal team and packaged as part of the agents they build.

### Task

A chat with an agent. The same primitive whether it's a quick question or a long piece of work. When it produces work — a proposed change, a PR, a report — it carries state: *in review*, *merged*, *rejected*, *archived*.

A task can spawn multiple PRs over its life. You keep prompting after the first merge and the next request becomes the next PR under the same task.

### Automation

An agent running without you.

- **Scheduled** — every weekday at 9am, run PageSpeed across the top pages.
- **Triggered** — when a 500 spike happens, run the diagnostic and propose a fix.

You don't watch them. You see what they produced — usually a finding, sometimes a task with a proposed PR.

### Findings

The way agents report. A finding is whatever the agent thinks deserves your attention — a regression PageSpeed caught, an error System Health saw, a conversion drop the diagnostic agent surfaced, a suggestion in the middle of a task.

Each finding is a card: what was found, what's proposed about it, a clear next action. Findings live with the agent that found them, but they aggregate into the home digest so you see the cross-cutting picture in the morning.

This is the magical-UX moment we're betting on. You arrive, and the agents have already done the looking.

### Files

Anything that exists: an uploaded banner, an agent-generated report, a slide, a PDF, a screenshot.

Every file has an *owner* (person or agent) and an *access list*. The defaults:

- **You make a file** → private to you.
- **An agent makes a file** → visible to everyone on the agent's team.

Sharing means adding people or agents to the access list. The user thinks in views, not paths: *My files · Shared with me · Files of agent X · Org-wide*. Same shared filesystem, filtered.

---

## The surfaces

### Home

Where you arrive. A chat in the center talking to the org's pilot (it can route to any agent). Below, a grid of **tiles** — the user picks what they want pinned. **Findings is always there**; other tiles surface tasks awaiting review, recent automations, a specific agent's stats, whatever the user adds. Starter prompts under the chat input give new users a few entry points; they collapse after the first send.

### Agent surface

What you see when you open an agent.

- **Storefront** → the Agentic CMS: site preview, CMS forms, chat panel, assets browser (showing org-level assets), settings.
- **Specialist** → its dashboard. What it watches, what it found, when it last ran.
- **Integration** → minimal. Usually a chat where you can address it directly, plus settings.

### Findings

A card per finding: what was found, what's proposed, one action. Findings live with the agent that produced them — open PageSpeed to see PageSpeed's, QA to see QA's. They aggregate into the home tile so the user gets the cross-cutting picture without opening every agent.

### Tasks panel

Open tasks across your agents. Active, in review, merged. Clicking opens the task transcript with whatever it produced (preview, diff, file).

Automations appear here as their own row type — recurring entries with run history collapsed underneath.

### Settings

Connections, members, roles, branding, AI provider keys, SSO. Per-agent settings live with the agent.

---

## What it feels like in the morning

You sign in. The Home loads. The Findings tile shows three new items — PageSpeed caught two regressions overnight, System Health flagged a 500 spike, QA validated last night's release. A Tasks tile has one PR from yesterday awaiting your review. The Automations tile shows last night's runs all green. You scan, click the most important finding, approve the proposed fix. Less than five minutes from open to action.

The work has already been done. You're reviewing and steering, not driving from zero. That's the bet.

---

## UX principles we're betting on

**One product, one chrome.** No "inside" mode. Switching agents changes the context, not the chrome.

**Magical, not reactive.** The product is already doing things when you arrive. The chat is one way to engage, not the only way.

**One primitive.** Storefronts, specialists, integrations — all agents. Same rules, different surfaces.

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

Sharing happens through git: commit to your branch, open a PR to `main`. A human reviews and merges. `main` is the canonical published store. Full spec in [`org-filesystem-layout.md`](./org-filesystem-layout.md).

---

## Gimenes' open questions — quick answers

### 1. Home chat — what does it do?

Talking to Home talks to the org's pilot. It does one of three things per turn:

- a. **In place.** Small asks (a number, a summary, a quick fetch) get answered inline.
- b. **Sub-task to another agent.** When it needs another agent's tools, it calls that agent in the background. The sub-call shows as a collapsed line in the Home thread, expandable for detail.
- c. **Proposes opening a task elsewhere.** When the work deserves its own surface (multi-turn, ongoing investigation, persistent artifact), the pilot returns a card: *"This looks like work for PageSpeed. Open it there?"* Click to open the task in that agent. The user is not yanked away — they choose.
- d. User can always override the proposal: *"no, just answer here"* → the pilot tries inline instead.
- e. Discoverability via starter prompts under the input + a "what can I do?" affordance.

### 2. Just-in-time connection (Gmail mid-task)

- a. Attempt → fail → inline card asking for the connection. No detour.
- b. OAuth opens in a new tab; agent auto-continues on return.
- c. Connections are org-level by default; user can opt for personal.
- d. Scope upgrades (read-only → send) use the same inline flow.
- e. Decline = agent tries an alternative or fails cleanly.
- f. Every connection event audit-logged.

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
- d. Per run logs: inputs, prompt, tools called, side effects, cost.
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

---

## Where this fits

- [`design-docs.md`](./design-docs.md) — this file, the entry point.
- [`product-vision.md`](./product-vision.md) — what we sell, to whom, where it's going.
- [`primitives.md`](./primitives.md) — the building blocks in plain language and technical detail.
- [`system-design.md`](./system-design.md) — engineering view.
- [`org-filesystem-layout.md`](./org-filesystem-layout.md) — full filesystem spec.
- [`open-questions.md`](./open-questions.md) — what's still being designed.
