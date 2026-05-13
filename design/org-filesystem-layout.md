# Org Filesystem Layout Design

**Date:** 2026-05-13  
**Status:** Draft

## Overview

Each organization in Studio gets a unified filesystem — a single git repository where both humans and agents can navigate, store, and generate artifacts. The layout is minimal by convention: only a handful of prescribed paths, everything else is freeform.

## Layout

```
/                              ← org git repo, main branch (shared/published)
  AGENTS.md                    ← org-wide instructions, loaded by all agents on start
  skills/                      ← org-wide skills available to all agents
  artifacts/                   ← org-wide shared artifacts

  agents/                      ← all agents
    /<agent-slug>/             ← agent folder (see two cases below)
      AGENTS.md                ← agent config + instructions
      memory.json              ← agent persistent memory
      skills/                  ← agent-specific skills
      artifacts/               ← agent-generated artifacts
      automations/             ← agent automations
      ...                      ← freeform (plain agent) or worktrees (github agent)

  connections/                 ← all MCP connections
    /<connection-slug>/        ← one folder per connection
      mcp.json                 ← connection metadata
```

## Agent folder: two cases

The presence of a `github` property in `AGENTS.md` determines the layout of the agent's folder.

### Case 1: Plain agent (no `github` property)

The agent folder is a straightforward workspace. Files and directories are freeform artifacts created by the agent or humans.

```
/agents/support-triage/
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
/agents/web-developer/
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

The agent's **cwd on start** is `/agents/<agent-slug>/<branch>/` (the active branch worktree). It can navigate up to `/agents/<agent-slug>/` to see all branches, or further up to `/` to see the full org tree.

## `AGENTS.md` format

All `AGENTS.md` files use YAML frontmatter for machine-readable config, with the body as free-form instructions.

### Root `/AGENTS.md` (org-wide)

```markdown
---
name: Acme Corp
description: Org-wide instructions for all agents.
icon: building
---

All agents must follow these guidelines...
```

### `/<agent-slug>/AGENTS.md` (plain agent)

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

### `/<agent-slug>/AGENTS.md` (GitHub agent)

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
- The org owns one git repository. `main` is the shared, canonical layer.
- Each plain agent's folder lives directly on `main`.
- Each GitHub agent's child folders are git worktrees, one per branch.

### Working directory
- **Plain agent** cwd on start: `/agents/<agent-slug>/`
- **GitHub agent** cwd on start: `/agents/<agent-slug>/<active-branch>/`
- Agents can navigate up and read anything across the full tree.

### Writing
- Writing anywhere in the tree is allowed — the filesystem is global within the org.
- Changes inside a plain agent's folder land on `main` (or a PR branch if the agent creates one).
- Changes inside a GitHub agent's worktree folder land on that branch.

### Sharing
- Sharing = committing to your branch and opening a PR to `main`.
- Humans review and merge. `main` is the org's canonical published artifact store.

### Instructions loading order
1. `/AGENTS.md` (org-wide) is loaded first for every agent.
2. `/<agent-slug>/AGENTS.md` (agent-specific) is loaded second, extending or overriding org context.

### Skills loading order
1. `/skills/` (org-wide) — available to all agents.
2. `/agents/<agent-slug>/skills/` (agent-specific) — extends org skills.

## Connections

Each MCP connection gets a folder under `/connections/<connection-slug>/` with a single `mcp.json` describing it.

```
/connections/
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

| Path | Description |
|------|-------------|
| `/AGENTS.md` | Org-wide config + instructions. |
| `/skills/` | Org-wide skills. |
| `/agents/<slug>/AGENTS.md` | Agent config + instructions. `github:` triggers worktree mode. |
| `/agents/<slug>/memory.json` | Agent persistent memory. |
| `/agents/<slug>/skills/` | Agent-specific skills. |
| `/agents/<slug>/artifacts/` | Agent-generated artifacts. |
| `/agents/<slug>/automations/` | Agent automations. |
| `/agents/<slug>/<branch>/` | Git worktree (GitHub agents only). |
| `/artifacts/` | Org-wide shared artifacts. |
| `/connections/<slug>/mcp.json` | Connection metadata (no secrets). |

## Design rationale

- **Minimal convention** — only `AGENTS.md` and `skills/` are prescribed. Everything else is freeform.
- **`github` as the discriminator** — one property in frontmatter switches the agent from plain workspace to git worktree mode, keeping the layout unsurprising.
- **Git as the sharing mechanism** — branches give agents isolation; PRs make sharing intentional and reviewable.
- **Global visibility** — any agent or human can read the full tree.
- **Agent cwd as home** — agents start in their folder like a user in `~`, but can navigate anywhere.
- **Connections as first-class citizens** — `/connections/` makes the org's MCP wiring discoverable and navigable like any other part of the filesystem.
