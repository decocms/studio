import type { GuideResource } from "./index";

export const resources: GuideResource[] = [
  {
    name: "platform",
    uri: "docs://platform.md",
    description: "Deco CMS overview and core concepts.",
    text: `# Deco CMS platform overview

## What Deco CMS is

Deco CMS is an MCP control plane. It sits between AI agents and external services, handling authentication, routing, and observability for connected MCP servers.

## Core concepts

### Connection
A connection is a live link to an external MCP server. It exposes tools from that server and usually requires authentication.

### Agent
An agent, also called a Virtual MCP, is a curated workspace-facing assistant. It combines selected connections, optional virtual tools, and instructions into a focused experience.

### Virtual tool
A virtual tool is custom JavaScript that runs inside an agent sandbox. Use virtual tools when you need glue logic across multiple tools or data transformations that a single connection does not provide.

### Automation
An automation is a background workflow triggered by a schedule, event, or webhook. It runs without an interactive chat session.

### AI provider
AI providers supply the models and credentials Decopilot and agents use for generation.

## Practical guidance

- Connections provide capabilities.
- Agents package capabilities for a role or workflow.
- Virtual tools fill gaps between existing tools.
- Automations run the same capabilities in the background.
- AI providers determine which models are available.
`,
  },
];
