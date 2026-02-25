# Phase 22: Interview + Recommendations - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Post-login: user completes a focused 3-question chat interview about their goals using the existing decopilot chat UI. System recommends 2-3 agents to "hire" for the project based on diagnostic results + declared goals. User can start connection setup from a recommendation card.

</domain>

<decisions>
## Implementation Decisions

### Interview
- Uses the **existing decopilot chat UI** — not a new chat implementation
- Special **onboarding system prompt** that asks max 3 focused questions about goals and challenges
- Interview should complete in under 2 minutes
- Results (goals, challenges, priorities) persisted to the org's company context
- After the interview, automatically trigger agent recommendations

### Agent Recommendations
- Agents already exist at org/studio level — the onboarding doesn't create agents
- Recommendations are **rule-based scoring** against live Virtual MCP registry — no hardcoded agent IDs
- Based on: diagnostic results (tech stack, performance issues, SEO gaps) + declared goals from interview
- Show 2-3 agent recommendation cards
- Each card shows: agent purpose, plain-English explanation of WHY recommended, what connections it needs

### "Hire" Flow
- Clicking "Connect" on a recommendation card opens the connection setup wizard
- Connection type pre-populated from the agent's requirements
- After connecting, the agent shows up in the project's Agents sidebar (existing UI, read-only in projects)

### Architecture
- The interview runs in the existing decopilot chat infrastructure with a structured onboarding system prompt
- Agent recommendation engine is a function that scores Virtual MCPs against diagnostic data + goals
- The recommendation UI is a new component that renders after the interview completes
- Connection setup reuses the existing connection wizard — just pre-populates the type

### Claude's Discretion
- Exact system prompt for the onboarding interview
- Scoring algorithm for agent recommendations
- How to detect interview completion (3 questions answered)
- UI layout for recommendation cards
- How to transition from interview to recommendations view

</decisions>

<specifics>
## Specific Ideas

- The interview should feel conversational, not like a form — it's a chat
- Recommendations should feel personalized — "Based on your slow LCP and missing meta descriptions, we recommend..."
- The "hire" action should be one click away from the recommendation card
- Users want to see results, not do work — keep it minimal

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 22-interview-recommendations*
*Context gathered: 2026-02-25*
