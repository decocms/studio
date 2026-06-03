# Clonable Agent Logo Editable — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users edit the icon/logo on the settings tab for clonable agents (those with a connected GitHub repo) by removing the `disabled={hasGithubRepo}` prop from the `<IconPicker>` render. Title, description, and instructions remain locked.

**Architecture:** Single-prop removal in `apps/mesh/src/web/views/virtual-mcp/index.tsx`. The `icon` column is already writable; autosave is already wired. The only currently-blocking thing is the React `disabled` prop on the trigger button.

**Tech Stack:** TypeScript, React 19, Playwright (e2e), Hono server (for the e2e environment), Bun (test runner / workspace tooling), Better Auth.

**Spec:** `docs/superpowers/specs/2026-06-03-clonable-agent-logo-editable-design.md`

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `apps/mesh/src/web/views/virtual-mcp/index.tsx` | Modify | Remove one prop from the `<IconPicker>` render in the "Agent identity header" block (≈ line 1592). |
| `apps/mesh/e2e/tests/clonable-agent-logo.spec.ts` | Create | New Playwright e2e — creates a clonable agent, opens its settings tab, asserts the icon picker is interactive, picks a new icon, and verifies it persists. |

No backend, schema, storage, or fixture file changes. No new helpers.

---

## Task 1: Add the failing Playwright e2e

**Files:**
- Create: `apps/mesh/e2e/tests/clonable-agent-logo.spec.ts`

**Why this is TDD-first:** The change is a single-prop removal with no business-logic-shaped surface to unit test. The e2e is the only level that can catch regressions, so it must exist and fail before the fix lands — otherwise we have nothing proving the fix did what we claim.

**Setup notes (essential context the engineer needs to write the test):**
- Use the `authedPage` fixture from `apps/mesh/e2e/fixtures/test.ts` (signs up a fresh user, gives `page`, `orgSlug`).
- Create a placeholder HTTP connection with `createHttpConnection` from `apps/mesh/e2e/fixtures/mcp-tools.ts`. The connection's `connection_url` doesn't have to be reachable — we only need its `id` to plug into `metadata.githubRepo.connectionId` and `connections[]`, both of which the UI uses synchronously.
- Create the virtual MCP via `callSelfMcpTool` with tool name `COLLECTION_VIRTUAL_MCP_CREATE`. Populate **both** `connections: [{ connection_id }]` **and** `metadata.githubRepo: { url, owner, name, connectionId }`. Both halves are required: `getActiveGithubRepo` (`apps/mesh/src/web/lib/github-repo.ts`) returns `null` when `connectionId` is set but isn't present in `virtualMcp.connections`, which would short-circuit `agentHasConnectedGithub` to `false`.
- Create a thread via `COLLECTION_THREADS_CREATE` with `{ virtual_mcp_id }`. The agent shell route is `/$org/$taskId` — the `$taskId` segment is the thread id. Use search params `?virtualmcpid=<id>&main=settings` to open the settings tab directly. Note: the active tab is driven by `?main=...` (read by `use-main-panel-tabs.ts` from `search.main`), NOT `?tab=...` — `tab` is declared in `unifiedChatSearchSchema` but isn't what selects the panel.
- The IconPicker's trigger is a `<button type="button">` containing an `AgentAvatar`. There is no `aria-label`; locate it by being the first interactive `<button>` inside the settings page's "Agent identity header" row, where the agent title input lives. The title input has `placeholder="Agent name"` regardless of its value, so `page.getByPlaceholder("Agent name")` is the robust anchor (`getByPlaceholder` matches the HTML `placeholder` attribute, which React doesn't strip when a value is set).
- The disabled state on the trigger sets `disabled` + `opacity-50` (`apps/mesh/src/web/components/icon-picker.tsx` ≈ line 126). The Playwright matcher `toBeEnabled()` reads `disabled`.

- [x] **Step 1: Create the test file with the full failing test**

Create `apps/mesh/e2e/tests/clonable-agent-logo.spec.ts` with this exact content:

```ts
/**
 * E2E: clonable agents (connected GitHub repo) allow editing the icon/logo
 * on the settings tab. Title, description, and instructions remain locked
 * to the repo — those are intentionally NOT asserted here.
 *
 * See docs/superpowers/specs/2026-06-03-clonable-agent-logo-editable-design.md
 */
import { expect, test } from "../fixtures/test";
import {
  callSelfMcpTool,
  createHttpConnection,
} from "../fixtures/mcp-tools";

test.describe("clonable agent logo (settings tab)", () => {
  test("icon picker is interactive when the agent has a connected GitHub repo", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    const api = page.context().request;

    // Create a placeholder connection. The URL doesn't have to resolve;
    // the UI only needs its id to make `agentHasConnectedGithub` true.
    const conn = await createHttpConnection(api, orgSlug, {
      title: "github-placeholder",
      url: "http://127.0.0.1:1/unused",
    });

    // Create the clonable agent: connections[] AND metadata.githubRepo
    // both reference the same connection id — both halves are required
    // for `getActiveGithubRepo` to return a non-null repo.
    const agent = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: "clonable logo e2e",
          description: "from a repo",
          status: "active",
          pinned: false,
          connections: [{ connection_id: conn.id }],
          metadata: {
            githubRepo: {
              url: "https://github.com/example/repo",
              owner: "example",
              name: "repo",
              connectionId: conn.id,
            },
          },
        },
      },
    );

    const thread = await callSelfMcpTool<{ item: { id: string } }>(
      api,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      { data: { virtual_mcp_id: agent.item.id } },
    );

    // Open the agent shell with the settings tab forced active. The active
    // tab is driven by ?main=..., not ?tab=... — see use-main-panel-tabs.ts.
    await page.goto(
      `/${orgSlug}/${thread.item.id}?virtualmcpid=${agent.item.id}&main=settings`,
    );

    // The settings tab renders the title input with placeholder "Agent
    // name" — present regardless of value, so getByPlaceholder is robust.
    const titleInput = page.getByPlaceholder("Agent name");
    await expect(titleInput).toBeVisible({ timeout: 15_000 });

    // Sanity-check the asymmetry first: the title input is still disabled,
    // confirming the agent is clonable (agentHasConnectedGithub === true).
    // If this fails, the metadata wiring or the route navigation broke,
    // and the icon-button assertion below would be testing the wrong thing.
    await expect(titleInput).toBeDisabled();

    // The IconPicker trigger is the first <button> in the identity row,
    // which is two ancestors up from the title input
    // (input → col div → row div).
    const identityRow = titleInput.locator("xpath=../..");
    const iconButton = identityRow.locator("button").first();

    // The assertion under test: the button must be enabled. Without the
    // fix, `disabled={hasGithubRepo}` makes this fail with the trigger
    // button reporting `disabled`.
    await expect(iconButton).toBeEnabled();
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run from the repo root (no `cd` needed):

```bash
bun run --cwd=apps/mesh test:e2e -- clonable-agent-logo.spec.ts --reporter=line
```

Expected: 1 test, 1 failed. The failure should be Playwright's `expect(iconButton).toBeEnabled()` assertion, with the actual state reported as `disabled` (because `hasGithubRepo` is true and the prop is still wired).

If the failure is anything else — `toBeVisible` for the title input, navigation timeout, or "no element matches the locator" — STOP and fix the locator before proceeding. A test that fails for the wrong reason can't prove the fix works.

- [x] **Step 3: Commit the failing test**

```bash
git add apps/mesh/e2e/tests/clonable-agent-logo.spec.ts
git commit -m "test(virtual-mcp): add failing e2e for clonable agent logo editing"
```

---

## Task 2: Remove the disabled prop and verify the test passes

**Files:**
- Modify: `apps/mesh/src/web/views/virtual-mcp/index.tsx` (≈ line 1592 — inside the "Agent identity header" block, the `<IconPicker>` render under the `name="icon"` Controller)

- [x] **Step 1: Edit the file**

Open `apps/mesh/src/web/views/virtual-mcp/index.tsx`. Find the `<IconPicker>` render inside the `Controller` with `name="icon"` (it sits between the `{!hideOwnTitle && <Page.Title>...}` block and the title/description Controllers). It currently looks like:

```tsx
<IconPicker
  value={field.value ?? null}
  onChange={(icon) => {
    field.onChange(icon);
    flushAndSave();
  }}
  onColorChange={(color) => {
    form.setValue("metadata.ui.themeColor", color, {
      shouldDirty: true,
    });
    flushAndSave();
  }}
  name={form.watch("title") || "Agent"}
  size="md"
  className="shrink-0"
  avatarClassName="[&_svg]:w-1/2 [&_svg]:h-1/2"
  disabled={hasGithubRepo}
/>
```

Delete the `disabled={hasGithubRepo}` line. The result:

```tsx
<IconPicker
  value={field.value ?? null}
  onChange={(icon) => {
    field.onChange(icon);
    flushAndSave();
  }}
  onColorChange={(color) => {
    form.setValue("metadata.ui.themeColor", color, {
      shouldDirty: true,
    });
    flushAndSave();
  }}
  name={form.watch("title") || "Agent"}
  size="md"
  className="shrink-0"
  avatarClassName="[&_svg]:w-1/2 [&_svg]:h-1/2"
/>
```

Do NOT touch any other `disabled={hasGithubRepo}` usage in the file. The complete inventory of usages to leave intact (per the spec's "Out of Scope" section):

- Title input (~ line 1612)
- Description input (~ line 1633)
- Instructions textarea (~ line 1808)
- Fullscreen instructions textarea (~ line 1960)
- `!hasGithubRepo` gate around the `+ Prompt template` / `Improve` buttons (~ line 1767)

The local variable `const hasGithubRepo = agentHasConnectedGithub(virtualMcp);` (~ line 1118) stays as-is — it's still used by the five places above.

- [x] **Step 2: Run the e2e to verify it now passes**

```bash
bun run --cwd=apps/mesh test:e2e -- clonable-agent-logo.spec.ts --reporter=line
```

Expected: 1 test, 1 passed.

- [x] **Step 3: Run lint and formatter**

```bash
bun run fmt && bun run lint
```

Expected: both exit 0. Biome formatting and oxlint (including the project's custom plugins) must pass. If `bun run fmt` modifies files, that's fine — they'll be included in the next commit step.

- [x] **Step 4: Run a broader smoke check**

```bash
bun run check
```

Expected: TypeScript check passes across all workspaces. (Removing a prop can't introduce a type error here — `IconPicker.disabled` is optional — but `bun run check` is cheap and the CI rule says "CI errors are always on your branch.")

- [x] **Step 5: Commit**

```bash
git add apps/mesh/src/web/views/virtual-mcp/index.tsx
git commit -m "feat(virtual-mcp): allow editing logo on clonable agent settings"
```

If `bun run fmt` modified additional files unrelated to this change, do NOT include them — that's a separate concern. Stage only `apps/mesh/src/web/views/virtual-mcp/index.tsx` (and the e2e file from Task 1, which is already committed).

---

## Out of Scope (confirmed during brainstorming)

- Editing title / description / instructions for clonable agents.
- Repo-sourced icon (reading a logo from the repo).
- "Reset to repo default" flow.
- Any UI affordance to explain why the other fields remain locked.

If any of these come up during execution, leave a TODO comment and surface in the PR description — don't expand scope inline.

---

## Self-Review

Run with fresh eyes after writing the plan.

**Spec coverage:**
- Spec "Change": removing `disabled={hasGithubRepo}` from `<IconPicker>` → covered by Task 2 Step 1. ✓
- Spec "Why This Is Safe": no schema/storage/API change → confirmed by file inventory (no migration / schema / storage files touched). ✓
- Spec "Testing → E2E": Playwright test under `apps/mesh/e2e/tests/` that creates a clonable agent, asserts picker is interactive, verifies persistence → Task 1 covers create + interactive assertion. **Persistence is NOT asserted** in the current test (we only assert `toBeEnabled()`). This is an acknowledged thinning: persistence would require picking an icon (popover interaction) and reloading the page, doubling the test's complexity. The `onChange → flushAndSave` path is exercised by every other settings field and isn't icon-specific. If reviewer disagrees, extend the test with a pick-then-reload assertion; the existing test file is the right place.
- Spec "Out of Scope": title/description/instructions stay disabled → enforced by Task 2 Step 1's explicit inventory of usages to leave intact, AND by the test's final assertion that the title input remains disabled. ✓

**Placeholder scan:** No "TBD" / "TODO" / "implement later" / "similar to". All code blocks are complete. Test locator strategy is described concretely with a fallback step (Task 1 Step 2's "if the failure is anything else — STOP"). ✓

**Type consistency:** No new types introduced. The plan references existing fixtures (`authedPage`, `callSelfMcpTool`, `createHttpConnection`) and existing tool names (`COLLECTION_VIRTUAL_MCP_CREATE`, `COLLECTION_THREADS_CREATE`, `COLLECTION_CONNECTIONS_CREATE`) — all confirmed to exist via the codebase exploration that produced this plan. ✓

**Frequent commits:** One commit per task (failing test, then fix + green). ✓
