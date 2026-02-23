# ConnectionsSetup Component Design

**Date:** 2026-02-23
**Status:** Approved

## Overview

`ConnectionsSetup` is a context-agnostic React component that guides a user through installing, authenticating, and configuring a declared set of MCP connections. It is used in onboarding flows (project templates, agent installs) where a known set of MCPs must be present and ready before the user can proceed.

It renders all slots vertically — no multi-step navigation. Satisfied slots collapse; unsatisfied slots show inline forms.

## Component API

```typescript
type ConnectionSlot = {
  label: string
  registry: string   // registry connection app_name or id
  item_id: string    // registry item id
}

type ConnectionsSetupProps = {
  slots: Record<string, ConnectionSlot>
  onComplete: (connections: Record<string, string>) => void  // slotId → connection_id
}
```

The component owns no persistence. Callers fetch specs from wherever they live (agent records, template configs, etc.) and pass them as props. `onComplete` fires once every slot is satisfied — the returned record maps each slot ID to the resolved connection ID, leaving wiring decisions entirely to the caller.

## Slot Resolution

On mount, each slot queries existing connections filtered by `metadata.registry_item_id === slot.item_id`.

- **One+ found, at least one satisfied** → `DONE` (first satisfied match selected)
- **One+ found, none satisfied** → `PICKER` (user selects an existing connection or installs fresh)
- **None found** → `FORM` (straight to install)
- **Registry item not found** → `ERROR` ("Registry item not found. Check your registry connection.")

## Render States

### DONE
Collapsed card showing connection name and icon. Includes a `[change ▾]` button that reopens the PICKER or FORM inline.

### LOADING
Skeleton card shown during initial slot resolution.

### PICKER
Shown when compatible connections already exist. Displays a dropdown of existing matching connections. User can select one and confirm, or choose "Install fresh" to expand the FORM inline.

### FORM (INSTALL → AUTH → CONFIG → DONE)
A single slot card that progresses through up to three sub-phases:

**INSTALL**
- `extractConnectionData(registryItem)` pre-fills connection params
- User submits → `CONNECTION_CREATE` mutation
- On success → determine next phase based on registry item metadata

**AUTH — OAuth** (if registry item has `oauth_config`)
- Renders "Authorize with [Provider]" button
- Opens OAuth redirect (same flow as connection detail page)
- On `oauth-callback` → polls for `status === "active"`

**AUTH — Token** (if registry item requires token/header, no OAuth)
- Renders token or header input
- Submit → `CONNECTION_UPDATE` (encrypted via vault)
- Polls for `status === "active"`

**AUTH — None** (MCP works without auth)
- Skipped. Polls for `status === "active"` immediately after install.

**CONFIG** (only if connection has a `configuration_state` schema)
- Renders form derived from the config schema
- Submit → `CONNECTION_CONFIGURE` (or equivalent update)

**Polling**: after each mutation, poll `CONNECTION_GET` every 2s, up to 15s, waiting for `status === "active"`. On timeout → error state with retry option on the slot.

## Satisfaction Criteria

A connection is considered satisfied when:
1. `status === "active"` (tools listed successfully, no 401)
2. If the connection has a `configuration_state` schema → config has been submitted and is valid

`onComplete` fires when every slot in the `slots` record is simultaneously satisfied.

## File Structure

```
apps/mesh/src/web/components/connections-setup/
  index.ts                    ← re-exports ConnectionsSetup
  connections-setup.tsx       ← root component, maps slots → SlotCard list
  slot-card.tsx               ← single slot, owns phase state machine
  slot-install-form.tsx       ← INSTALL phase
  slot-auth-oauth.tsx         ← AUTH phase — OAuth button + polling
  slot-auth-token.tsx         ← AUTH phase — token/header input
  slot-config-form.tsx        ← CONFIG phase — config schema form
  slot-done.tsx               ← collapsed done card with [change]
  use-slot-resolution.ts      ← resolves initial slot state from existing connections
  use-connection-poller.ts    ← polls CONNECTION_GET until active or timeout
```

## Usage Examples

**Project template onboarding:**
```tsx
<ConnectionsSetup
  slots={{
    model: { label: "AI Model", registry: "official", item_id: "openai" },
    email: { label: "Email Provider", registry: "official", item_id: "resend" },
  }}
  onComplete={({ model, email }) => {
    enablePlugins(projectId, ["chat", "email"])
    wireConnections(projectId, { modelConnectionId: model, emailConnectionId: email })
    redirect(`/${org}/${project}`)
  }}
/>
```

**Marketplace agent install:**
```tsx
<ConnectionsSetup
  slots={{
    search: { label: "Web Search", registry: "official", item_id: "brave-search" },
    browser: { label: "Browser", registry: "official", item_id: "puppeteer" },
  }}
  onComplete={(connections) => {
    wireToAgent(agentId, connections)
    closeDialog()
  }}
/>
```

## What This Is Not

- Not a multi-step wizard — no next/back navigation
- Not responsible for persisting slot specs — caller owns that
- Not responsible for wiring connections to agents/projects — caller owns that via `onComplete`
- Does not support binding-based (flexible) slots — exact registry item reference only for now
