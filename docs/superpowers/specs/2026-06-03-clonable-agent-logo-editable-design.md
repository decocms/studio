# Allow Editing the Logo on Settings Tab for Clonable Agents

**Date:** 2026-06-03
**Status:** Approved (pending user review of written spec)
**Scope:** UI gating change in `apps/mesh/src/web/views/virtual-mcp/index.tsx`

## Problem

When a virtual MCP (agent) has a connected GitHub repo — i.e.,
`agentHasConnectedGithub(virtualMcp)` returns true — the settings tab disables
four identity fields:

| Field        | Location in `index.tsx`              |
| ------------ | ------------------------------------ |
| Icon / logo  | line 1592 (`<IconPicker disabled>`)  |
| Title        | line 1612                            |
| Description  | line 1633                            |
| Instructions | line 1808 (inline) + 1960 (fullscreen) |

Plus the `+ Prompt template` and `Improve` buttons are hidden behind a
`!hasGithubRepo` gate (line 1767).

The original intent appears to have been "if the agent comes from a repo, the
repo owns its identity." But the icon/logo is not actually sourced from the
repo today — it's a UI-only field stored on the `VirtualMCPEntity.icon`
column. Locking it prevents users from customizing the visual identity of a
cloned agent, which is a legitimate need (e.g., branding a forked template
with their own logo).

## Goal

Make the icon/logo editable for clonable agents (those with a connected
GitHub repo). Keep title, description, and instructions locked to the repo.

## Non-Goals

- Allow editing title, description, or instructions for clonable agents.
- Introduce a repo-sourced icon (e.g., reading a logo from the repo).
- Build a "reset to repo default" flow.
- Change the IconPicker component itself.
- Modify any backend, schema, or storage code.

## Design

### Change

Single-prop removal in `apps/mesh/src/web/views/virtual-mcp/index.tsx` at the
`<IconPicker>` render inside the "Agent identity header" block
(approximately lines 1572–1595):

```diff
 <IconPicker
   value={field.value ?? null}
   onChange={(icon) => { ... }}
   onColorChange={(color) => { ... }}
   name={form.watch("title") || "Agent"}
   size="md"
   className="shrink-0"
   avatarClassName="[&_svg]:w-1/2 [&_svg]:h-1/2"
-  disabled={hasGithubRepo}
 />
```

All other `disabled={hasGithubRepo}` usages in the file are left untouched:
- Title input (line 1612) — remains disabled.
- Description input (line 1633) — remains disabled.
- Instructions textarea (line 1808) — remains disabled.
- Fullscreen instructions textarea (line 1960) — remains disabled.
- `!hasGithubRepo` gate around `+ Prompt template` / `Improve` buttons (line
  1767) — remains.

### Why This Is Safe

1. **`icon` is already a writable field.** It lives on the top-level `icon`
   column of `VirtualMCPEntity` and is persisted via the same
   `actions.update` mutation that every other settings field uses. No
   schema, storage, or API change needed.
2. **No repo sync would clobber it.** `metadata.githubRepo` only holds
   `{ url, owner, name, connectionId }` — there is no icon field there and
   no process that copies an icon from the repo into the entity. Enabling
   the picker cannot trigger a write-then-overwrite race.
3. **Autosave is already wired.** `onChange` calls `flushAndSave()` and
   `onColorChange` writes `metadata.ui.themeColor` then calls
   `flushAndSave()` — both currently unreachable due to `disabled`. They
   will work as soon as the disabled prop is removed.
4. **Telemetry is correct.** The form-level `agent_updated` PostHog event
   (line 1188) accumulates dirty field names; it will record
   `fields: ["icon"]` (or `["icon", "metadata"]` if the color also changed),
   which is the truthful description of the edit.

### Visual Asymmetry

After this change, the identity header will show an editable icon next to a
disabled title and description. This is intentional and acceptable: the icon
is decorative and user-owned, while the title/description belong to the
repo. No additional visual treatment (tooltip, hint, badge) is added — the
disabled state of the adjacent fields is self-explanatory.

## Testing

This is a pure UI gating change with no testable logic in `.ts` files.

- **No unit tests** added. `agent-capabilities.ts` helpers are untouched.
- **E2E (Playwright)**: extend or add a test under `apps/mesh/e2e/tests/`
  that:
  1. Creates a clonable agent (connected GitHub repo).
  2. Navigates to the settings tab.
  3. Asserts the icon picker is interactive (clickable, opens popover).
  4. Picks a different icon.
  5. Reloads and asserts the new icon persisted.

  If a "clonable agent settings" e2e file already exists, extend it; else
  add a new file (e.g., `apps/mesh/e2e/tests/clonable-agent-logo.test.ts`).

## Rollout

- No feature flag needed — change is additive (removes a restriction) and
  fully reversible.
- No data migration.
- No documentation update needed (the docs in `apps/docs/` describe the
  intended system; allowing icon edits is consistent with treating the
  icon as a UI concern).

## Open Questions

None. The user (during brainstorming) confirmed scope is "logo only" — see
Q1, option A.
