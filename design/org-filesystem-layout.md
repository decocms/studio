# Org Filesystem Layout Design

**Date:** 2026-05-13  
**Status:** Draft

## Overview

The filesystem is a global tree with two roots: `/orgs` for organization workspaces and `/users` for personal workspaces. Both share the same internal layout — the user space is a trimmed-down mirror of the org space, scoped to the individual.

## Top-level structure

```
/
  orgs/
    <org-id>/              ← org workspace (full layout, see below)

  users/
    <user-id>/             ← personal workspace (same layout, no inner org)
```

## Org workspace layout (`/orgs/<org-id>/`)

```
/orgs/<org-id>/
  AGENTS.md                    ← org-wide instructions, loaded by all agents on start
  skills/                      ← org-wide skills available to all agents
  artifacts/                   ← org-wide shared artifacts

  agents/                      ← all agents
    <agent-slug>/              ← agent folder (see two cases below)
      AGENTS.md                ← agent config + instructions
      memory.json              ← agent persistent memory
      skills/                  ← agent-specific skills
      artifacts/               ← agent-generated artifacts
      automations/             ← agent automations
      ...                      ← freeform (plain agent) or worktrees (github agent)

  connections/                 ← all MCP connections
    <connection-slug>/         ← one folder per connection
      mcp.json                 ← connection metadata
```

## User workspace layout (`/users/<user-id>/`)

A personal workspace with the same internal structure as an org, but privately owned by the user. No org nesting — the user's root is the equivalent of an org root.

```
/users/<user-id>/
  AGENTS.md                    ← user-wide instructions for personal agents
  skills/                      ← personal skills
  artifacts/                   ← personal artifacts

  agents/
    <agent-slug>/
      AGENTS.md
      memory.json
      skills/
      artifacts/
      automations/
      ...

  connections/
    <connection-slug>/
      mcp.json
```

## Agent folder: two cases

The presence of a `github` property in `AGENTS.md` determines the layout of the agent's folder. This applies equally to org and user agents.

### Case 1: Plain agent (no `github` property)

The agent folder is a straightforward workspace. Files and directories are freeform artifacts created by the agent or humans.

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

### Case 2: GitHub agent (`github` property present)

The agent is linked to a GitHub repository. Child folders are **git worktrees**, one per branch. The agent checks out and works within a branch-named subfolder.

```
agents/web-developer/
  AGENTS.md                  ← has `github:` in frontmatter
  memory.json
  skills/
  artifacts/
  automations/
  main/                      ← worktree for main branch
    src/
    package.json
  feature-checkout-flow/     ← worktree for feature branch
    src/
    package.json
  fix-login-bug/             ← worktree for fix branch
    src/
```

The agent's **cwd on start** is `<workspace>/agents/<agent-slug>/<branch>/`. It can navigate up to see all branches, or further up to see the full workspace tree.

## `AGENTS.md` format

All `AGENTS.md` files use YAML frontmatter for machine-readable config, with the body as free-form instructions.

### Root `AGENTS.md` (org-wide or user-wide)

```markdown
---
name: Acme Corp
description: Org-wide instructions for all agents.
icon: building
---

All agents must follow these guidelines...
```

### Agent `AGENTS.md` (plain agent)

```markdown
---
name: Support Triage
description: Handles incoming support tickets for B2B merchants.
icon: headset
mcps:
  - connection_id: conn_abc123
    selected_tools: [SEARCH, READ]
    selected_resources: null
    selected_prompts: null
  - connection_id: conn_def456
    selected_tools: null
    selected_resources: null
    selected_prompts: null
---

<role>
You are the support triage agent for B2B merchants.
</role>

<capabilities>
- Investigate account issues using the connected CRM and ticketing tools.
</capabilities>
```

### Agent `AGENTS.md` (GitHub agent)

```markdown
---
name: Web Developer
description: Builds and maintains the company web app.
icon: code
github:
  url: https://github.com/acme/web-app
  owner: acme
  name: web-app
  installation_id: 98765
mcps:
  - connection_id: conn_github_abc
    selected_tools: null
    selected_resources: null
    selected_prompts: null
---

<role>
You are the web developer agent for the Acme web app.
</role>
```

## Rules

### Repository structure
- Each org and each user owns one git repository. `main` is the shared, canonical layer.
- Each plain agent's folder lives directly on `main`.
- Each GitHub agent's child folders are git worktrees, one per branch.

### Working directory
- **Plain agent** cwd on start: `<workspace>/agents/<agent-slug>/`
- **GitHub agent** cwd on start: `<workspace>/agents/<agent-slug>/<active-branch>/`
- Agents can navigate up and read anything across the full workspace tree.

### Writing

| Location | Plain agent | GitHub agent |
|----------|-------------|--------------|
| `agents/<slug>/artifacts/` | ✅ writable | ✅ writable |
| `agents/<slug>/` (all other paths) | ❌ read-only | ✅ writable (lands on the active branch) |
| Workspace root, `connections/`, `skills/` | ✅ writable | ✅ writable |

For plain agents (no `github` property), `agents/<slug>/artifacts/` is the **only** writable location inside the agent folder. All other paths — `AGENTS.md`, `memory.json`, `skills/`, `automations/`, and any freeform files — are read-only at runtime. Changes to those must be made by humans through the UI or directly in the repository.

GitHub agents have no such restriction: they work inside a git worktree and can write freely within their branch.

### Sharing
- Sharing = committing to your branch and opening a PR to `main`.
- Humans review and merge. `main` is the canonical published artifact store.

### Instructions loading order
1. Workspace root `AGENTS.md` is loaded first for every agent.
2. `agents/<agent-slug>/AGENTS.md` is loaded second, extending or overriding the root context.

### Skills loading order
1. Workspace root `skills/` — available to all agents in the workspace.
2. `agents/<agent-slug>/skills/` — agent-specific, extends workspace skills.

## Connections

Each MCP connection gets a folder under `connections/<connection-slug>/` with a single `mcp.json` describing it.

```
connections/
  linear/
    mcp.json
  github/
    mcp.json
  postgres-prod/
    mcp.json
```

### `mcp.json` shape

```json
{
  "connection_id": "conn_abc123",
  "name": "Linear",
  "description": "Linear issue tracker integration.",
  "icon": "linear",
  "url": "https://mcp.linear.app/sse",
  "auth_type": "oauth2"
}
```

Secrets and credentials are never stored in `mcp.json` — only public metadata needed to identify and describe the connection.

## Well-known paths

Paths below are relative to the workspace root (`/orgs/<org-id>/` or `/users/<user-id>/`).

| Path | Description |
|------|-------------|
| `AGENTS.md` | Workspace-wide config + instructions. |
| `skills/` | Workspace-wide skills. |
| `artifacts/` | Workspace-wide shared artifacts. |
| `agents/<slug>/AGENTS.md` | Agent config + instructions. `github:` triggers worktree mode. |
| `agents/<slug>/memory.json` | Agent persistent memory. |
| `agents/<slug>/skills/` | Agent-specific skills. |
| `agents/<slug>/artifacts/` | Agent-generated artifacts. |
| `agents/<slug>/automations/` | Agent automations. |
| `agents/<slug>/<branch>/` | Git worktree (GitHub agents only). |
| `connections/<slug>/mcp.json` | Connection metadata (no secrets). |

## Design rationale

- **Dual roots** — `/orgs` and `/users` give the same powerful workspace layout to both teams and individuals without any special-casing in the internal structure.
- **Minimal convention** — only `AGENTS.md`, `memory.json`, and a handful of well-known folders are prescribed. Everything else is freeform.
- **`github` as the discriminator** — one property in frontmatter switches the agent from plain workspace to git worktree mode, keeping the layout unsurprising.
- **Git as the sharing mechanism** — branches give agents isolation; PRs make sharing intentional and reviewable.
- **Global visibility** — any agent or human can read the full workspace tree.
- **Agent cwd as home** — agents start in their folder like a user in `~`, but can navigate anywhere.
- **Connections as first-class citizens** — `connections/` makes the workspace's MCP wiring discoverable and navigable like any other part of the filesystem.
