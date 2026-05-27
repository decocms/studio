# Home Next-Actions via MCP Prompts

**Status:** Approved — ready for implementation plan
**Date:** 2026-05-26
**Owner:** tlgimenes

## Summary

Replace the pre-seeded `thrd_welcome_<agentId>` threads + sidebar "Up next" view with a new home-page surface. Each Studio Pack agent's checklist item becomes a real MCP prompt; the home page renders the still-incomplete ones as cards below the chat input. Clicking a card creates a new thread with the right agent and autosends the prompt — going through the args dialog first if the prompt declares any arguments. Storefront Manager's non-thread checklist items (which open UI dialogs instead of starting threads) stay alongside the prompt cards as a separate "dialog card" kind.

## Goals

- Remove the welcome-thread scaffolding (`createWelcomeThreadsStep`, `/api/:org/studio-pack-welcome`, the materializer `useEffect`, per-agent `welcomeMessage`).
- Move the "Up next" surface from the sidebar to the `/$org` home, below `Chat.Input`.
- Drive each next-action card from a real MCP prompt; preserve the existing server-side completion filter so done items disappear.
- Reuse the existing prompts pipeline (`useMCPPromptsList`, `PromptArgsDialog`, `getPrompt`, `createMentionDoc`, `derivePartsFromTiptapDoc`, `writeStoredAutosend`, `createNewTask`). Build only the small glue hook.
- Keep storefront-manager's dialog-based items present, as separate dialog cards on the same home row.

## Non-goals

- A "featured prompt" opt-in convention or per-prompt curation metadata. Per-agent prompt visibility is enforced via `selected_prompts`; nothing broader in this pass.
- Touching `useSuggestedActions` (in-progress "needs review" threads). It does not appear on the home in this change; we may revisit later.
- Refactoring `ice-breakers.tsx` to share the new glue hook. Possible follow-up, out of scope here.
- Surfacing a prompt-picker UI on the home (the picker still lives in chat input via `SlashMention`).

## Reuse map

| Concern | Reused from |
|---|---|
| List prompts for an agent | `useMCPPromptsList({ client })` (`@decocms/mesh-sdk`) |
| Args gating + dialog | `PromptArgsDialog`, `PromptArgumentValues` (`apps/mesh/src/web/components/chat/dialog-prompt-arguments.tsx`) |
| Resolve a prompt with args | `getPrompt(client, name, args)` (`@decocms/mesh-sdk`) |
| Build mention chip | `createMentionDoc`, `stripToolNamespace`, `getGatewayClientId` |
| Tiptap doc → autosend parts | `derivePartsFromTiptapDoc` (`apps/mesh/src/web/components/chat/derive-parts.ts`) |
| Reserve id + autosend on mount | `writeStoredAutosend` + existing chat-context autosend `useEffect` |
| Create the thread row + navigate | `createNewTask(virtualMcpId)` from `usePanelActions()` |
| Studio-pack agent identity | `STUDIO_PACK_AGENTS`, `findStudioPackAgentByMcpId`, `getId(orgId)` |

The reference implementation pattern lives in `ice-breakers.tsx` (reducer + `handlePromptSelection` + `handleDialogSubmit` + `loadPrompt`). The new hook follows the same shape; only the terminal action differs.

## Architecture

### Server side

1. **New prompts file.** `apps/mesh/src/tools/guides/studio-pack-onboarding.ts` exports `prompts: GuidePrompt[]` with one entry per current checklist thread-action item — ~10 entries across the 5 Studio Pack agents. Names follow `<agent-slug>-<item-slug>` (e.g. `brand-manager-complete-profile`, `brand-manager-create-landing-page`, `store-manager-…`). Each `text` is the existing `action.prompt`; for items without one today (e.g. Brand Manager's "Set up your brand"), we author a one-line trigger sentence and rely on the agent's existing instructions (e.g. Brand Manager's `INSTRUCTIONS_BOOTSTRAP`) to drive the rest. Agents without an explicit bootstrap instruction get a prompt whose text encodes the same intent directly. `tools/guides/index.ts` includes the new module via `getPrompts()`.

2. **Per-agent prompt whitelist.** Each studio-pack agent file (`brand-manager.ts`, `agent-manager.ts`, `automation-manager.ts`, `connection-manager.ts`, `store-manager.ts`) gains a `selectedPrompts: readonly string[]` field listing only its own checklist prompt names. `installStudioPack` writes that list to `selected_prompts` on the connection row (instead of `null`). A boot-time backfill upgrades existing rows.

3. **New endpoint** `GET /api/:org/home-next-actions` (replaces `/api/:org/studio-pack-checklists`). Server-side completion filter stays: each item's `isCompleted({ orgId, ctx })` runs and incomplete items are returned. Response shape:

   ```ts
   {
     prompts: Array<{
       agentId: string;
       agentName: string;
       agentIcon: string | null;
       promptName: string;
       title: string;
       description: string;
       hasArguments: boolean;
     }>;
     dialogs: Array<{
       agentId: string;
       agentName: string;
       agentIcon: string | null;
       label: string;
       kind:
         | "install-github-mcp"
         | "add-storefront"
         | "configure-github-automations"
         | "setup-site-monitoring"
         | "github-import";
     }>;
   }
   ```

   `hasArguments` is derived from the prompt's MCP definition so the client can decide whether to short-circuit the args dialog without an extra fetch.

4. **Removed server code:**
   - `createWelcomeThreadsStep` and its call site in `installStudioPackWorkflowFn` (`apps/mesh/src/auth/install-studio-pack-workflow.ts`).
   - `apps/mesh/src/api/routes/studio-pack-welcome.ts` and its mount in `apps/mesh/src/api/app.ts`.
   - `welcomeMessage` field on each studio-pack agent + the `BuildWelcomeMessage` type from `apps/mesh/src/tools/virtual/studio-pack/types.ts`.
   - `ChecklistItemAction` union shrinks: drop the `prompt?: string` field on `open-agent-thread` (text now lives in the MCP prompt). Dialog kinds (`github-import`, `install-github-mcp`, `add-storefront`, `configure-github-automations`, `setup-site-monitoring`) stay because dialog cards remain.

### Frontend side

1. **New hook** `useStartThreadFromPrompt({ agentId })` in `apps/mesh/src/web/hooks/use-start-thread-from-prompt.tsx`:
   - Internal state: `dialogPrompt: Prompt | null`, mirroring `ice-breakers.tsx`.
   - Exposes `start(prompt)` and a `dialog` ReactNode (the rendered `PromptArgsDialog`).
   - `start(prompt)`: if `prompt.arguments?.length > 0`, set `dialogPrompt`. Otherwise call internal `loadAndStart(prompt)`.
   - `loadAndStart(prompt, args?)`:
     1. `client = useMCPClient({ connectionId: agentId, orgId, orgSlug })` (resolved at hook scope).
     2. `result = await getPrompt(client, prompt.name, args)`.
     3. Build a one-paragraph tiptap doc containing `createMentionDoc({ id: prompt.name, name: stripToolNamespace(prompt.name, getGatewayClientId(prompt._meta)), metadata: result.messages, char: "/", kind: "prompt", args })`.
     4. `parts = derivePartsFromTiptapDoc(doc)`.
     5. `newId = crypto.randomUUID()`.
     6. `writeStoredAutosend(sessionStorage, locator, newId, { parts })`.
     7. `await create({ id: newId, virtual_mcp_id: agentId })` (same call `createNewTask` uses).
     8. `setTaskId(newId, agentId)` — navigates to `/$org/$taskId`, autosend `useEffect` in chat-context fires the first message.
   - Errors: toast on `getPrompt` failure, reset dialog state.

2. **New home component** `apps/mesh/src/web/components/home/next-actions-row.tsx`:
   - Uses `useHomeNextActions(orgSlug)`.
   - Renders prompt cards and dialog cards in a single horizontally-scrolling row (desktop) / vertical stack (mobile). Card style mirrors current `ChecklistItemCard`: `AgentAvatar`, agent name (small), action title (medium).
   - Prompt card `onClick`: `useStartThreadFromPrompt({ agentId }).start(promptFromList)`.
     - We feed the hook a synthetic `Prompt` reconstructed from `{ name, title, description, arguments }`. If `hasArguments` is true, the hook needs the actual `arguments` definitions for the dialog — to avoid an extra `listPrompts` round-trip, the endpoint includes them under a new field `arguments?: Prompt["arguments"]` in the prompt entry. (Cheap; same data the server already pulled to compute `hasArguments`.)
   - Dialog card `onClick`: opens the relocated dialog modal (`AddStorefrontModal`, `InstallGitHubMcpDialog`, `GitHubRepoPicker`, `SetupSiteMonitoringModal`). On dialog close, invalidate `KEYS.homeNextActions(orgSlug)`.
   - Loading state: 3 skeleton cards, same look as today.

3. **`home-page/index.tsx`** renders `<NextActionsRow />` inside the main column under `Chat.Input`, both mobile and desktop branches. Hidden when the no-AI-provider empty state is shown.

4. **Hook rename** `useStudioPackChecklists` → `useHomeNextActions`. New file `apps/mesh/src/web/hooks/use-home-next-actions.ts`; the old one is deleted. `KEYS.studioPackChecklists` → `KEYS.homeNextActions` in `apps/mesh/src/web/lib/query-keys.ts`.

5. **Sidebar simplification** (`apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx`):
   - Remove `viewMode` state, `VIEW_MODE_LABELS`, the view-mode dropdown.
   - Remove imports of `useSuggestedActions`, `useStudioPackChecklists`, related types.
   - Remove the `ChecklistItemCard` component definition.
   - Remove all dialog `useState` toggles + their `Modal/Dialog` mounts (`GitHubRepoPicker`, `InstallGitHubMcpDialog`, `AddStorefrontModal`, `SetupSiteMonitoringModal`).
   - Remove the `dispatchChecklistAction` switch.
   - The list always renders the grouped view (by-agent default, by-status via the filter popover — that toggle stays).

6. **Chat context** — delete the studio-pack welcome materializer `useEffect` in `apps/mesh/src/web/components/chat/chat-context.tsx` (lines ~1046–1086) along with its `isStudioPackAgent` import if no other reference remains.

### Defensive UI filter for stale welcome threads

To avoid existing orgs surfacing dangling `thrd_welcome_*` rows once the materializer is gone, add a filter inside `groupThreadsByVirtualMcp` (`apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts`): skip any thread whose id starts with `thrd_welcome_`. This is the only client-side cleanup; we deliberately don't run a destructive DB migration in this change.

## Data flow (prompt card click, end-to-end)

1. Server boot: `installStudioPack` (idempotent) ensures the 5 agents exist and each has `selected_prompts` populated. Backfill updates rows where `selected_prompts` is `null`.
2. User lands on `/$org`. `useHomeNextActions(orgSlug)` fetches `/api/:org/home-next-actions` → server iterates studio-pack agents, evaluates `isCompleted` per item, filters out completed, attaches prompt metadata (including `arguments`) by looking up the registered MCP prompt by name. Returns `prompts[]` + `dialogs[]`.
3. `NextActionsRow` renders cards.
4. User clicks "Complete your brand profile" → `start(prompt)` on the hook scoped to Brand Manager's vMCP id.
5. Since this prompt has no arguments, hook goes straight to `loadAndStart`. `getPrompt` resolves the messages, `createMentionDoc` builds the chip, `derivePartsFromTiptapDoc` produces autosend parts, `writeStoredAutosend` queues them, `create` + `setTaskId` lands the user on the new thread.
6. Chat-context's existing autosend `useEffect` fires the first message on mount; the agent responds.

For a prompt **with** arguments, step 5 routes through `PromptArgsDialog` first; on submit the rest of the flow runs unchanged with `args` forwarded to `getPrompt` and `createMentionDoc`.

## Migration & rollout

- **No data destruction.** Existing `thrd_welcome_*` rows are left in place; the UI filter hides them.
- **Backfill** runs once at server boot via the existing `backfillStudioPackForAllOrgs` mechanism: for each studio-pack connection row where `selected_prompts` is `null`, replace with the agent's whitelist. Idempotent on subsequent boots.
- **No feature flag.** Cutover is atomic on deploy — the old endpoint and the new endpoint don't coexist; the sidebar "Up next" toggle is removed in the same PR.

## Touched files (rough census)

**Add:**
- `apps/mesh/src/tools/guides/studio-pack-onboarding.ts`
- `apps/mesh/src/api/routes/home-next-actions.ts`
- `apps/mesh/src/web/hooks/use-home-next-actions.ts`
- `apps/mesh/src/web/hooks/use-start-thread-from-prompt.tsx`
- `apps/mesh/src/web/components/home/next-actions-row.tsx`

**Modify:**
- `apps/mesh/src/tools/guides/index.ts` (include new prompts)
- `apps/mesh/src/tools/virtual/studio-pack/{brand,agent,automation,connection,store}-manager.ts` (add `selectedPrompts`, remove `welcomeMessage`)
- `apps/mesh/src/tools/virtual/studio-pack/types.ts` (shrink `ChecklistItemAction` — drop `prompt?` on `open-agent-thread`, remove `BuildWelcomeMessage`)
- `apps/mesh/src/tools/virtual/studio-pack/index.ts` (re-exports + `installStudioPack` writes `selected_prompts`)
- `apps/mesh/src/auth/install-studio-pack-workflow.ts` (drop `createWelcomeThreadsStep`, add backfill step for `selected_prompts`)
- `apps/mesh/src/api/app.ts` (unmount welcome route, mount new endpoint)
- `apps/mesh/src/web/lib/query-keys.ts` (rename key)
- `apps/mesh/src/web/layouts/home-page/index.tsx` (render `<NextActionsRow />`)
- `apps/mesh/src/web/components/chat/chat-context.tsx` (remove welcome materializer `useEffect`)
- `apps/mesh/src/web/components/sidebar/task-groups/task-groups-list.tsx` (drop "Up next" mode + dialog mounts)
- `apps/mesh/src/web/components/sidebar/task-groups/group-threads.ts` (filter `thrd_welcome_*`)

**Remove:**
- `apps/mesh/src/api/routes/studio-pack-welcome.ts`
- `apps/mesh/src/web/layouts/tasks-panel/use-studio-pack-checklists.ts` (replaced by `use-home-next-actions.ts`)
- `apps/mesh/src/web/layouts/tasks-panel/use-suggested-actions.ts` if no remaining callers after sidebar cleanup (verify during implementation)

## Testing

- **Server:** unit tests for `home-next-actions` endpoint — verify completion filtering, prompt arguments are attached, dialog kinds enumerated for storefront-manager. Existing studio-pack-checklists tests are ported/replaced.
- **Frontend:** `useStartThreadFromPrompt` hook test exercising both the no-args and with-args paths against a mocked client. Snapshot the `parts` shape produced for a representative prompt to lock in the `derivePartsFromTiptapDoc` integration.
- **Manual:** open `/$org` with a fresh org → see all checklist items as prompt cards + storefront dialog cards. Complete one (e.g. set brand context) → that card disappears on refetch. Click "Complete your brand profile" → lands in a Brand Manager thread with the first message already sent. Click "Connect GitHub" (dialog card) → InstallGitHubMcpDialog opens; on close, the card disappears.

## Open / deferred

- Per-prompt curation (the dropped option D from brainstorming) — revisit if the home row becomes too dense.
- Sharing `useStartThreadFromPrompt` with `ice-breakers.tsx` — easy follow-up once both surfaces have shipped.
- Cleaning up dangling `thrd_welcome_*` rows in the DB — leave for a future maintenance pass; UI filter is enough for now.
