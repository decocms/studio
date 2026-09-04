import { expect, test } from "../fixtures/test";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function createCodeWorkspace(
  api: Parameters<typeof createHttpConnection>[0],
  orgSlug: string,
  threadTitle?: string,
) {
  await callSelfMcpTool(api, orgSlug, "AI_PROVIDER_KEY_CREATE", {
    providerId: "anthropic",
    label: "compact-code-workspace-e2e",
    apiKey: "sk-ant-e2e-fake-key-do-not-use",
  });
  const connection = await createHttpConnection(api, orgSlug, {
    title: "compact-code-workspace-placeholder",
    url: "http://127.0.0.1:1/unused",
  });
  const agent = await callSelfMcpTool<{ item: { id: string } }>(
    api,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: "Compact Code workspace e2e",
        description: "Rendered compact file-explorer coverage",
        status: "active",
        pinned: false,
        connections: [{ connection_id: connection.id }],
        metadata: {
          githubRepo: {
            url: "https://github.com/example/compact-code-workspace",
            owner: "example",
            name: "compact-code-workspace",
            connectionId: connection.id,
          },
          ui: { layout: { cms: "on" } },
        },
      },
    },
  );
  const thread = await callSelfMcpTool<{
    item: { id: string; branch: string | null };
  }>(api, orgSlug, "COLLECTION_THREADS_CREATE", {
    data: {
      virtual_mcp_id: agent.item.id,
      branch: "draft",
      ...(threadTitle ? { title: threadTitle } : {}),
    },
  });
  expect(thread.item.branch).toBe("draft");
  return { agentId: agent.item.id, threadId: thread.item.id };
}

test.describe("Compact Code workspace", () => {
  test.setTimeout(90_000);

  test("keeps a short stacked workspace feasible and hands keyboard focus between Main toggles", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 1000, height: 360 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: { files: [], directories: [], truncated: false },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=true&mainpanel=true`,
    );

    const group = page.locator('[data-workspace-layout="stacked"]');
    const main = page.getByTestId("main-panel");
    const chat = page.getByTestId("side-panel");
    await expect(group).toBeVisible({ timeout: 30_000 });
    await expect(main).toBeVisible();
    await expect(chat).toBeVisible();

    const [groupBox, mainBox, chatBox] = await Promise.all([
      group.boundingBox(),
      main.boundingBox(),
      chat.boundingBox(),
    ]);
    expect(groupBox).not.toBeNull();
    expect(mainBox).not.toBeNull();
    expect(chatBox).not.toBeNull();
    if (!groupBox || !mainBox || !chatBox) {
      throw new Error("The short stacked workspace must be measurable");
    }
    expect(mainBox.height).toBeGreaterThan(0);
    expect(chatBox.height).toBeGreaterThan(0);
    expect(mainBox.y + mainBox.height).toBeLessThanOrEqual(chatBox.y);
    expect(mainBox.height + chatBox.height).toBeLessThan(groupBox.height);

    const hideMain = page.getByRole("button", {
      name: "Hide panel",
      exact: true,
    });
    await hideMain.focus();
    await expect(hideMain).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.searchParams.get("mainpanel") === "false",
      { timeout: 30_000 },
    );

    const showMain = chat.getByRole("button", {
      name: "Show panel",
      exact: true,
    });
    await expect(showMain).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForURL(
      (url) => url.searchParams.get("mainpanel") === "true",
      { timeout: 30_000 },
    );
    await expect(hideMain).toBeFocused();
  });

  test("drills into one pane with deterministic focus and preserves editor state", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    // Both viewport sizes stay on the desktop shell side of its 768px
    // boundary, so only Code's own container mode changes.
    await page.setViewportSize({ width: 1280, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    let readRequests = 0;
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: ["src/app.tsx", "README.md"],
            directories: ["src"],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        readRequests++;
        const body = route.request().postDataJSON() as { path?: string };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content:
              body.path === "README.md"
                ? "# Compact workspace\n"
                : [
                    'export const original = "seed";',
                    "const spacer = true;",
                    "",
                    'export const target = "needle";',
                    "",
                  ].join("\n"),
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/grep(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            results: 'src/app.tsx:4:export const target = "needle";',
            matchCount: 1,
          },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
    );

    const search = page.getByRole("textbox", {
      name: "Search files",
      exact: true,
    });
    const back = page.getByRole("button", {
      name: "Back to files",
      exact: true,
    });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await expect(back).toHaveCount(0);
    await search.focus();
    await page.setViewportSize({ width: 800, height: 844 });
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    await expect(back).toHaveCount(0);

    await page.getByRole("button", { name: "src", exact: true }).click();
    const appFile = page.getByRole("button", {
      name: "app.tsx",
      exact: true,
    });
    const tabs = page.getByRole("tablist", { name: "Files", exact: true });
    const appTab = tabs.getByRole("tab", {
      name: /^app\.tsx(?: Unsaved changes)?$/,
    });
    const readmeTab = tabs.getByRole("tab", {
      name: "README.md",
      exact: true,
    });
    await expect(appFile).toBeVisible();
    await appFile.click();

    await expect(back).toBeVisible();
    await expect(back).toBeFocused();
    await expect(search).toHaveCount(0);
    const editorInput = page
      .locator(".monaco-editor textarea.inputarea")
      .first();
    const editorText = page.locator(".monaco-editor .view-lines").first();
    await expect(editorInput).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/^Saved\s*·\s*typescript$/)).toBeVisible();
    expect(readRequests).toBe(1);

    const uniqueUnsavedLines = [
      'export const original = "survives-shell-breakpoint";',
      "const spacer = true;",
      "",
      'export const target = "needle";',
    ];
    const expectExactEditorBuffer = async () => {
      await expect
        .poll(async () =>
          (await editorText.locator(".view-line").allTextContents()).map(
            (line) => line.replaceAll("\u00a0", " "),
          ),
        )
        .toEqual(uniqueUnsavedLines);
    };
    await editorInput.focus();
    const selectAllShortcut = await page.evaluate(() =>
      navigator.platform.toLowerCase().includes("mac") ? "Meta+A" : "Control+A",
    );
    await editorInput.press(selectAllShortcut);
    await editorInput.press("Backspace");
    await page.keyboard.insertText(uniqueUnsavedLines.join("\n"));
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();
    await expectExactEditorBuffer();

    // The shell keeps one provider/Outlet tree mounted across its 768px
    // desktop/mobile boundary. An unsaved Monaco model and its selected file
    // must therefore survive both directions without a reload.
    await page.setViewportSize({ width: 767, height: 844 });
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();
    await expectExactEditorBuffer();
    await page.setViewportSize({ width: 800, height: 844 });
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();
    await expectExactEditorBuffer();

    // Exercise the router's history listener rather than issuing a new page
    // navigation: a file-only route update must not remount Code or lose A.
    await page.evaluate(() => {
      const next = new URL(window.location.href);
      next.searchParams.set("file", "/README.md");
      window.history.pushState(null, "", next);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("file") === "/README.md",
    );
    await expect(readmeTab).toHaveAttribute("aria-selected", "true");
    await expect(appTab).toBeVisible();
    await expect(page.getByText(/^Saved\s*·\s*markdown$/)).toBeVisible();
    expect(readRequests).toBe(2);

    await appTab.click();
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();
    await expectExactEditorBuffer();

    // Crossing the component's compact breakpoint keeps the mounted editor
    // buffer while exposing the tree and editor side by side.
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(search).toBeVisible();
    await expect(back).toHaveCount(0);
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();

    await page.setViewportSize({ width: 800, height: 844 });
    await expect(back).toBeVisible();
    await expect(search).toHaveCount(0);
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();

    await back.click();
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    await expect(back).toHaveCount(0);
    // Drill-out does not collapse the tree selected before entering the editor.
    await expect(appFile).toBeVisible();

    await appFile.click();
    await expect(back).toBeVisible();
    await expect(back).toBeFocused();
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();
    await expectExactEditorBuffer();
    expect(readRequests).toBe(2);

    // Widening removes Code's compact Back control. The active file tab is
    // the persistent equivalent and must receive focus before the button goes.
    await page.setViewportSize({ width: 1280, height: 844 });
    await expect(back).toHaveCount(0);
    await expect(appTab).toBeFocused();
    await page.setViewportSize({ width: 800, height: 844 });
    await expect(back).toBeVisible();

    // The file is already mounted, but hidden behind the compact tree. A
    // content hit must wait for the editor pane to become visible before it
    // reveals the line and hands keyboard focus to Monaco.
    await back.click();
    await search.fill("target needle");
    const contentHit = page.getByTitle("/src/app.tsx:4");
    await expect(contentHit).toBeVisible();
    await contentHit.click();
    await expect(editorInput).toBeVisible();
    await expect(editorInput).toBeFocused();
    await expect(
      page.locator(".monaco-editor .line-numbers.active-line-number").first(),
    ).toHaveText("4");
    expect(readRequests).toBe(2);

    /* Preview, Content, and Code are sibling routes under one Site Editor.
       Leaving Code therefore unmounts its route body. The route-scoped
       workspace owns open tabs and dirty buffers so that ordinary editor
       navigation cannot silently discard work. This is intentionally a real
       route transition, not a viewport change or file-only history update. */
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/site-editor` &&
        url.searchParams.get("thread") === threadId,
      { timeout: 30_000 },
    );
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: "Site Editor",
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Code", exact: true }).click();
    await page.waitForURL(
      (url) =>
        url.pathname === `/${orgSlug}/agents/${agentId}/site-editor/code` &&
        url.searchParams.get("thread") === threadId,
      { timeout: 30_000 },
    );
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/^Modified\s*·\s*typescript$/)).toBeVisible();
    await expectExactEditorBuffer();
    expect(readRequests).toBe(2);

    await appTab.focus();
    await page.keyboard.press("ArrowRight");
    await expect(readmeTab).toBeFocused();
    await expect(readmeTab).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("ArrowLeft");
    await expect(appTab).toBeFocused();
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expectExactEditorBuffer();

    /* Dirty tabs expose their state in the accessible name and never close on
       an ambiguous click or Delete key. Cancel keeps the buffer; Discard is
       the explicit destructive path and hands selection to the adjacent tab. */
    await expect(appTab).toHaveAccessibleName("app.tsx Unsaved changes");
    await page
      .getByRole("button", { name: "Close app.tsx", exact: true })
      .click();
    const unsavedDialog = page.getByRole("alertdialog", {
      name: "Save changes to app.tsx?",
      exact: true,
    });
    await expect(unsavedDialog).toBeVisible();
    await unsavedDialog
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(unsavedDialog).toBeHidden();
    await expect(appTab).toHaveAttribute("aria-selected", "true");
    await expectExactEditorBuffer();

    await appTab.focus();
    await page.keyboard.press("Delete");
    await expect(unsavedDialog).toBeVisible();
    await unsavedDialog
      .getByRole("button", { name: "Discard", exact: true })
      .click();
    await expect(unsavedDialog).toHaveCount(0);
    await expect(appTab).toHaveCount(0);
    await expect(readmeTab).toHaveAttribute("aria-selected", "true");
    await expect(readmeTab).toBeFocused();
    expect(readRequests).toBe(2);
  });

  test("a localized branch change guard keeps the unsaved Code draft when cancelled", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.addInitScript(() => {
      try {
        const key = "studio:user:preferences";
        const current = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(
          key,
          JSON.stringify({ ...current, language: "pt-BR" }),
        );
      } catch {
        /* Sandboxed child frames may have no storage; the app frame does. */
      }
    });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: ["src/app.tsx"],
            directories: ["src"],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content: 'export const original = "seed";\n',
          },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
    );
    await expect(
      page.getByRole("textbox", {
        name: "Pesquisar arquivos",
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "app.tsx", exact: true }).click();

    const editor = page.locator(".monaco-editor").first();
    const editorInput = editor.locator("textarea.inputarea");
    await expect(editor.locator(".view-lines")).toContainText("original");
    await editorInput.focus();
    await expect(editorInput).toBeFocused();
    await page.keyboard.insertText("// rascunho-local");
    await expect(editor.locator(".view-lines")).toContainText("rascunho-local");

    const dirtyTab = page.getByRole("tab", {
      name: "app.tsx Alterações não salvas",
      exact: true,
    });
    await expect(dirtyTab).toHaveAttribute("aria-selected", "true");

    const branchPicker = page
      .locator('[data-slot="main-topbar-right"]')
      .getByRole("button", { name: "draft", exact: true });
    await expect(branchPicker).toBeVisible();
    await branchPicker.click();
    await page
      .getByPlaceholder("Pesquisar branches…", { exact: true })
      .fill("troca-segura");
    await page
      .getByRole("button", {
        name: 'Criar "troca-segura"',
        exact: true,
      })
      .click();

    const guard = page.getByRole("alertdialog", {
      name: "Descartar alterações não salvas?",
      exact: true,
    });
    await expect(guard).toBeVisible();
    await expect(guard).toContainText(
      "Trocar de branch ou sair do Editor do Site descartará permanentemente suas alterações de código não salvas.",
    );
    await guard
      .getByRole("button", { name: "Continuar editando", exact: true })
      .click();

    await expect(guard).toHaveCount(0);
    await expect(branchPicker).toHaveAccessibleName("draft");
    await expect(dirtyTab).toHaveAttribute("aria-selected", "true");
    await expect(editor.locator(".view-lines")).toContainText("rascunho-local");
    expect(new URL(page.url()).pathname).toBe(
      `/${orgSlug}/agents/${agentId}/site-editor/code`,
    );
  });

  test("discarding a localized thread change clears the retained Code draft", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.addInitScript(() => {
      try {
        const key = "studio:user:preferences";
        const current = JSON.parse(localStorage.getItem(key) ?? "{}");
        localStorage.setItem(
          key,
          JSON.stringify({ ...current, language: "pt-BR" }),
        );
      } catch {
        /* Sandboxed child frames may have no storage; the app frame does. */
      }
    });

    const { agentId, threadId: sourceThreadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
      "Conversa de origem",
    );
    const targetThread = await callSelfMcpTool<{ item: { id: string } }>(
      page.context().request,
      orgSlug,
      "COLLECTION_THREADS_CREATE",
      {
        data: {
          virtual_mcp_id: agentId,
          title: "Conversa de destino",
          branch: "draft",
        },
      },
    );

    let readRequests = 0;
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: ["src/app.tsx"],
            directories: ["src"],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        readRequests++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content: 'export const original = "seed";\n',
          },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${sourceThreadId}&sidepanel=true&mainpanel=true`,
    );
    await expect(
      page.getByRole("textbox", {
        name: "Pesquisar arquivos",
        exact: true,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "app.tsx", exact: true }).click();

    const editor = page.locator(".monaco-editor").first();
    const editorInput = editor.locator("textarea.inputarea");
    await expect(editor.locator(".view-lines")).toContainText("original");
    await editorInput.focus();
    await page.keyboard.insertText("// rascunho-da-origem");
    await expect(editor.locator(".view-lines")).toContainText(
      "rascunho-da-origem",
    );
    await expect(
      page.getByRole("tab", {
        name: "app.tsx Alterações não salvas",
        exact: true,
      }),
    ).toBeVisible();
    expect(readRequests).toBe(1);

    const threadsMenu = page
      .getByTestId("side-panel")
      .getByRole("button", { name: "Chats", exact: true });
    await threadsMenu.click();
    const targetThreadRow = page.locator(
      `[data-task-id="${targetThread.item.id}"]`,
    );
    await expect(targetThreadRow).toContainText("Conversa de destino");
    await targetThreadRow.click();

    const guard = page.getByRole("alertdialog", {
      name: "Descartar alterações não salvas?",
      exact: true,
    });
    await expect(guard).toBeVisible();
    await guard
      .getByRole("button", { name: "Descartar e continuar", exact: true })
      .click();
    await page.waitForURL(
      (url) => url.searchParams.get("thread") === targetThread.item.id,
      { timeout: 30_000 },
    );
    await expect(guard).toHaveCount(0);

    await threadsMenu.click();
    const sourceThreadRow = page.locator(`[data-task-id="${sourceThreadId}"]`);
    await expect(sourceThreadRow).toContainText("Conversa de origem");
    await sourceThreadRow.click();
    await page.waitForURL(
      (url) => url.searchParams.get("thread") === sourceThreadId,
      { timeout: 30_000 },
    );
    await expect(guard).toHaveCount(0);

    await expect(
      page.getByRole("tab", {
        name: "app.tsx Alterações não salvas",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", {
        name: "Pesquisar arquivos",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "src", exact: true }).click();
    await page.getByRole("button", { name: "app.tsx", exact: true }).click();
    await expect(editor.locator(".view-lines")).toContainText("original");
    await expect(editor.locator(".view-lines")).not.toContainText(
      "rascunho-da-origem",
    );
    await expect(
      page.getByRole("tab", { name: "app.tsx", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    expect(readRequests).toBe(2);
  });

  test("keeps the latest deep-link intent when an older ancestor listing resolves late", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const releaseLazyListing = deferred();
    const lazyListingResponded = deferred();
    const lazyListingPaths: string[] = [];
    const readPaths: string[] = [];
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        if (body.path) {
          lazyListingPaths.push(body.path);
          await releaseLazyListing.promise;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            json: {
              files: ["deep/one/two/slow.ts"],
              directories: ["deep/one/two"],
              truncated: false,
            },
          });
          lazyListingResponded.resolve();
          return;
        }

        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: ["README.md", "deep/one/two/slow.ts"],
            directories: ["deep", "deep/one", "deep/one/two"],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        readPaths.push(body.path ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content:
              body.path === "README.md"
                ? "# Latest file intent\n"
                : 'export const stale = "slow";\n',
          },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
    );
    await expect(
      page.getByRole("textbox", { name: "Search files", exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    await page.evaluate(() => {
      const next = new URL(window.location.href);
      next.searchParams.set("file", "/deep/one/two/slow.ts");
      window.history.pushState(null, "", next);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect
      .poll(() => lazyListingPaths, {
        message: "the older deep-link must be waiting on lazy ancestry",
      })
      .toEqual(["deep/one/two"]);

    await page.evaluate(() => {
      const next = new URL(window.location.href);
      next.searchParams.set("file", "/README.md");
      window.history.pushState(null, "", next);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    const tabs = page.getByRole("tablist", { name: "Files", exact: true });
    const readmeTab = tabs.getByRole("tab", {
      name: "README.md",
      exact: true,
    });
    await expect(readmeTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText(/^Saved\s*·\s*markdown$/)).toBeVisible();
    expect(readPaths).toEqual(["README.md"]);

    releaseLazyListing.resolve();
    await lazyListingResponded.promise;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );

    await expect(readmeTab).toHaveAttribute("aria-selected", "true");
    await expect(
      tabs.getByRole("tab", { name: "slow.ts", exact: true }),
    ).toHaveCount(0);
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("file") === "/README.md",
    );
    expect(readPaths).toEqual(["README.md"]);
  });

  test("coalesces a deferred read across drill-out and close-to-reopen", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const appRead = deferred();
    const readmeRead = deferred();
    const readCounts = new Map<string, number>();
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: ["src/app.tsx", "README.md"],
            directories: ["src"],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        const path = body.path ?? "";
        readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
        await (path === "README.md" ? readmeRead.promise : appRead.promise);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content:
              path === "README.md"
                ? "# Reopened while loading\n"
                : 'export const coalesced = "once";\n',
          },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
    );
    const search = page.getByRole("textbox", {
      name: "Search files",
      exact: true,
    });
    const back = page.getByRole("button", {
      name: "Back to files",
      exact: true,
    });
    await expect(search).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "src", exact: true }).click();
    const appFile = page.getByRole("button", {
      name: "app.tsx",
      exact: true,
    });
    await appFile.click();
    await expect.poll(() => readCounts.get("src/app.tsx") ?? 0).toBe(1);

    await back.click();
    await appFile.click();
    expect(readCounts.get("src/app.tsx")).toBe(1);
    appRead.resolve();
    await expect(page.getByText(/^Saved\s*·\s*typescript$/)).toBeVisible();
    await expect(
      page.locator(".monaco-editor .view-lines").first(),
    ).toContainText('export const coalesced = "once";');
    expect(readCounts.get("src/app.tsx")).toBe(1);

    await back.click();
    const readmeFile = page.getByRole("button", {
      name: "README.md",
      exact: true,
    });
    await readmeFile.click();
    await expect.poll(() => readCounts.get("README.md") ?? 0).toBe(1);
    await page
      .getByRole("button", { name: "Close README.md", exact: true })
      .click();
    await back.click();
    await readmeFile.click();
    expect(readCounts.get("README.md")).toBe(1);

    readmeRead.resolve();
    await expect(page.getByText(/^Saved\s*·\s*markdown$/)).toBeVisible();
    await expect(
      page.locator(".monaco-editor .view-lines").first(),
    ).toContainText("# Reopened while loading");
    expect(readCounts.get("README.md")).toBe(1);
  });

  test("drops a deferred pre-rename payload and loads the renamed path", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const oldPathRead = deferred();
    const renamedPathRead = deferred();
    const readCounts = new Map<string, number>();
    const renameRequests: Array<{ from?: string; to?: string }> = [];
    let renamed = false;
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: [renamed ? "src/renamed.ts" : "src/rename-me.ts"],
            directories: ["src"],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        const path = body.path ?? "";
        readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
        await (path === "src/renamed.ts"
          ? renamedPathRead.promise
          : oldPathRead.promise);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content:
              path === "src/renamed.ts"
                ? 'export const current = "renamed path";\n'
                : 'export const stale = "old path";\n',
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/rename(?:\\?|$)`),
      async (route) => {
        renameRequests.push(
          route.request().postDataJSON() as { from?: string; to?: string },
        );
        renamed = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
    );
    await expect(
      page.getByRole("textbox", { name: "Search files", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "src", exact: true }).click();
    const oldFile = page.getByRole("button", {
      name: "rename-me.ts",
      exact: true,
    });
    await oldFile.click();
    await expect.poll(() => readCounts.get("src/rename-me.ts") ?? 0).toBe(1);

    await page
      .getByRole("button", { name: "Back to files", exact: true })
      .click();
    await oldFile.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename" });
    await renameDialog
      .getByRole("textbox", { name: "Name" })
      .fill("renamed.ts");
    await renameDialog
      .getByRole("button", { name: "Rename", exact: true })
      .click();

    await expect
      .poll(() => renameRequests)
      .toEqual([{ from: "src/rename-me.ts", to: "src/renamed.ts" }]);
    await expect.poll(() => readCounts.get("src/renamed.ts") ?? 0).toBe(1);
    await expect(renameDialog).toBeHidden();

    oldPathRead.resolve();
    await page.getByRole("button", { name: "src", exact: true }).click();
    const renamedFile = page.getByRole("button", {
      name: "renamed.ts",
      exact: true,
    });
    await renamedFile.click();
    expect(readCounts.get("src/renamed.ts")).toBe(1);
    await expect(
      page.getByText("/src/renamed.ts", { exact: true }),
    ).toBeVisible();

    renamedPathRead.resolve();
    await expect(page.getByText(/^Saved\s*·\s*typescript$/)).toBeVisible();
    await expect(
      page.locator(".monaco-editor .view-lines").first(),
    ).toContainText('export const current = "renamed path";');
    await expect(
      page.getByRole("button", { name: "Close rename-me.ts", exact: true }),
    ).toHaveCount(0);
    expect(readCounts.get("src/rename-me.ts")).toBe(1);
    expect(readCounts.get("src/renamed.ts")).toBe(1);
  });

  test("does not let an older create-file completion steal a newer deep-link", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const createWriteReached = deferred();
    const releaseCreateWrite = deferred();
    const writePaths: string[] = [];
    const readPaths: string[] = [];
    let created = false;
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: created ? ["README.md", "created.ts"] : ["README.md"],
            directories: [],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/write(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        writePaths.push(body.path ?? "");
        createWriteReached.resolve();
        await releaseCreateWrite.promise;
        created = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        readPaths.push(body.path ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content:
              body.path === "README.md"
                ? "# Newer route intent\n"
                : 'export const staleCreate = "must not open";\n',
          },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
    );
    await expect(
      page.getByRole("textbox", { name: "Search files", exact: true }),
    ).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: "New file", exact: true }).click();
    const createDialog = page.getByRole("dialog", {
      name: "New File",
      exact: true,
    });
    await createDialog
      .getByRole("textbox", { name: "Name" })
      .fill("created.ts");
    await createDialog
      .getByRole("button", { name: "Create", exact: true })
      .click();
    await createWriteReached.promise;
    expect(writePaths).toEqual(["created.ts"]);

    await page.evaluate(() => {
      const next = new URL(window.location.href);
      next.searchParams.set("file", "/README.md");
      window.history.pushState(null, "", next);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    // The pending modal makes the background accessibility-inert, so inspect
    // the still-mounted tab by its DOM state until the create request settles.
    const tabs = page.locator('[data-code-pane="editor"] [role="tablist"]');
    const readmeTab = tabs
      .locator('[role="tab"][aria-selected="true"]')
      .filter({ hasText: "README.md" });
    await expect(readmeTab).toHaveAttribute("aria-selected", "true");
    expect(readPaths).toEqual(["README.md"]);

    releaseCreateWrite.resolve();
    await expect(createDialog).toBeHidden();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        }),
    );
    await expect(readmeTab).toHaveAttribute("aria-selected", "true");
    await expect(
      tabs.getByRole("tab", { name: "created.ts", exact: true }),
    ).toHaveCount(0);
    expect(readPaths).toEqual(["README.md"]);
  });

  test("reloads a tab opened while its parent-directory rename is pending", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const renameReached = deferred();
    const releaseRename = deferred();
    const oldPathRead = deferred();
    const newPathRead = deferred();
    const readCounts = new Map<string, number>();
    let renamed = false;
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: [renamed ? "renamed-src/child.ts" : "src/child.ts"],
            directories: [renamed ? "renamed-src" : "src"],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/rename(?:\\?|$)`),
      async (route) => {
        renameReached.resolve();
        await releaseRename.promise;
        renamed = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        const path = body.path ?? "";
        readCounts.set(path, (readCounts.get(path) ?? 0) + 1);
        await (path === "renamed-src/child.ts"
          ? newPathRead.promise
          : oldPathRead.promise);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content:
              path === "renamed-src/child.ts"
                ? 'export const current = "new path";\n'
                : 'export const stale = "old path";\n',
          },
        });
      },
    );

    await page.goto(
      `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
    );
    await expect(
      page.getByRole("textbox", { name: "Search files", exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    const sourceFolder = page.getByRole("button", {
      name: "src",
      exact: true,
    });
    await sourceFolder.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const renameDialog = page.getByRole("dialog", { name: "Rename" });
    await renameDialog
      .getByRole("textbox", { name: "Name" })
      .fill("renamed-src");
    await renameDialog
      .getByRole("button", { name: "Rename", exact: true })
      .click();
    await renameReached.promise;

    await page.evaluate(() => {
      const next = new URL(window.location.href);
      next.searchParams.set("file", "/src/child.ts");
      window.history.pushState(null, "", next);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await expect.poll(() => readCounts.get("src/child.ts") ?? 0).toBe(1);

    releaseRename.resolve();
    await expect
      .poll(() => readCounts.get("renamed-src/child.ts") ?? 0)
      .toBe(1);
    await expect(renameDialog).toBeHidden();
    await expect(
      page.getByText("/renamed-src/child.ts", { exact: true }),
    ).toBeVisible();

    oldPathRead.resolve();
    newPathRead.resolve();
    await expect(page.getByText(/^Saved\s*·\s*typescript$/)).toBeVisible();
    const editorText = page.locator(".monaco-editor .view-lines").first();
    await expect(editorText).toContainText(
      'export const current = "new path";',
    );
    await expect(editorText).not.toContainText("old path");
    expect(readCounts.get("src/child.ts")).toBe(1);
    expect(readCounts.get("renamed-src/child.ts")).toBe(1);
  });

  test("remaps a deep-link still discovering ancestors when its directory rename lands", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const renameReached = deferred();
    const releaseRename = deferred();
    const oldLazyReached = deferred();
    const releaseOldLazy = deferred();
    const lazyPaths: string[] = [];
    const readPaths: string[] = [];
    let renamed = false;
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        if (body.path) {
          lazyPaths.push(body.path);
          if (body.path === "deep/one/two") {
            oldLazyReached.resolve();
            await releaseOldLazy.promise;
          }
          const root = renamed ? "renamed-deep" : "deep";
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            json: {
              files: [`${root}/one/two/child.ts`],
              directories: [`${root}/one/two`],
              truncated: false,
            },
          });
          return;
        }
        const root = renamed ? "renamed-deep" : "deep";
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: [`${root}/one/two/child.ts`],
            directories: [root, `${root}/one`, `${root}/one/two`],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/rename(?:\\?|$)`),
      async (route) => {
        renameReached.resolve();
        await releaseRename.promise;
        renamed = true;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        readPaths.push(body.path ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content: 'export const current = "renamed lazy path";\n',
          },
        });
      },
    );

    try {
      await page.goto(
        `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
      );
      await expect(
        page.getByRole("textbox", { name: "Search files", exact: true }),
      ).toBeVisible({ timeout: 30_000 });
      await page
        .getByRole("button", { name: "deep", exact: true })
        .click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      const renameDialog = page.getByRole("dialog", { name: "Rename" });
      await renameDialog
        .getByRole("textbox", { name: "Name" })
        .fill("renamed-deep");
      await renameDialog
        .getByRole("button", { name: "Rename", exact: true })
        .click();
      await renameReached.promise;

      await page.evaluate(() => {
        const next = new URL(window.location.href);
        next.searchParams.set("file", "/deep/one/two/child.ts");
        window.history.pushState(null, "", next);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await oldLazyReached.promise;
      expect(lazyPaths).toEqual(["deep/one/two"]);
      expect(readPaths).toEqual([]);

      releaseRename.resolve();
      await expect.poll(() => lazyPaths).toContain("renamed-deep/one/two");
      await expect
        .poll(() => readPaths)
        .toEqual(["renamed-deep/one/two/child.ts"]);
      await expect(renameDialog).toBeHidden();
      await expect(
        page.getByText("/renamed-deep/one/two/child.ts", { exact: true }),
      ).toBeVisible();

      releaseOldLazy.resolve();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(readPaths).toEqual(["renamed-deep/one/two/child.ts"]);
      await expect(
        page.getByRole("button", { name: "Close child.ts", exact: true }),
      ).toHaveCount(1);
      await expect(
        page.locator(".monaco-editor .view-lines").first(),
      ).toContainText('export const current = "renamed lazy path";');
    } finally {
      releaseRename.resolve();
      releaseOldLazy.resolve();
    }
  });

  test("serializes repeated saves and reopens the newest persisted value", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const firstWriteReached = deferred();
    const releaseFirstWrite = deferred();
    const secondWriteFinished = deferred();
    const writeContents: string[] = [];
    let persistedContent = "# Original\n";
    let readRequests = 0;
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: { files: ["README.md"], directories: [], truncated: false },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        readRequests++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: { kind: "file", content: persistedContent },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/write(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { content?: string };
        const content = body.content ?? "";
        writeContents.push(content);
        if (writeContents.length === 1) {
          firstWriteReached.resolve();
          await releaseFirstWrite.promise;
        }
        persistedContent = content;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
        if (writeContents.length === 2) secondWriteFinished.resolve();
      },
    );
    await page.route(
      new RegExp(
        `/api/${orgSlug}/sandbox/${agentId}/draft/git/status(?:\\?|$)`,
      ),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            not_added: [],
            conflicted: [],
            created: [],
            deleted: [],
            modified: [],
            renamed: [],
            files: [],
            staged: [],
            ahead: 0,
            behind: 0,
            current: "draft",
            tracking: null,
            detached: false,
          },
        });
      },
    );

    try {
      await page.goto(
        `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
      );
      const readmeFile = page.getByRole("button", {
        name: "README.md",
        exact: true,
      });
      await expect(readmeFile).toBeVisible({ timeout: 30_000 });
      await readmeFile.click();
      const input = page.locator(".monaco-editor textarea.inputarea").first();
      const editorText = page.locator(".monaco-editor .view-lines").first();
      await expect(input).toBeVisible({ timeout: 30_000 });
      const selectAllShortcut = await page.evaluate(() =>
        navigator.platform.toLowerCase().includes("mac")
          ? "Meta+A"
          : "Control+A",
      );
      const saveShortcut = await page.evaluate(() =>
        navigator.platform.toLowerCase().includes("mac")
          ? "Meta+S"
          : "Control+S",
      );
      const replaceEditor = async (content: string) => {
        await input.focus();
        await input.press(selectAllShortcut);
        await input.press("Backspace");
        await page.keyboard.insertText(content);
        await expect(editorText).toContainText(content);
      };

      await replaceEditor("# First delayed");
      await input.press(saveShortcut);
      await firstWriteReached.promise;
      await replaceEditor("# Newest persisted");
      await input.press(saveShortcut);
      await page.waitForTimeout(250);
      expect(writeContents).toEqual(["# First delayed"]);

      releaseFirstWrite.resolve();
      await secondWriteFinished.promise;
      expect(writeContents).toEqual(["# First delayed", "# Newest persisted"]);
      await expect(page.getByText(/^Saved\s*·\s*markdown$/)).toBeVisible();

      await page
        .getByRole("button", { name: "Close README.md", exact: true })
        .click();
      await expect(
        page.getByRole("textbox", { name: "Search files", exact: true }),
      ).toBeVisible();
      await readmeFile.click();
      await expect.poll(() => readRequests).toBe(2);
      await expect(editorText).toContainText("# Newest persisted");
      await expect(editorText).not.toContainText("# First delayed");
    } finally {
      releaseFirstWrite.resolve();
    }
  });

  test("drains saves before rename/delete and sends later saves to the renamed path", async ({
    authedPage,
  }) => {
    const { page, orgSlug } = authedPage;
    await page.setViewportSize({ width: 800, height: 844 });
    const { agentId, threadId } = await createCodeWorkspace(
      page.context().request,
      orgSlug,
    );

    const renameWriteReached = deferred();
    const releaseRenameWrite = deferred();
    const deleteWriteReached = deferred();
    const releaseDeleteWrite = deferred();
    const files = new Map([
      ["rename-me.ts", 'export const value = "rename original";\n'],
      ["delete-me.ts", 'export const value = "delete original";\n'],
    ]);
    const writePaths: string[] = [];
    const renameRequests: Array<{ from?: string; to?: string }> = [];
    const deleteRequests: Array<{ path?: string }> = [];

    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/glob(?:\\?|$)`),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            files: [...files.keys()],
            directories: [],
            truncated: false,
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/read(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            kind: "file",
            content: files.get(body.path ?? "") ?? "",
          },
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/write(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as {
          path?: string;
          content?: string;
        };
        const path = body.path ?? "";
        writePaths.push(path);
        if (path === "rename-me.ts") {
          renameWriteReached.resolve();
          await releaseRenameWrite.promise;
        } else if (path === "delete-me.ts") {
          deleteWriteReached.resolve();
          await releaseDeleteWrite.promise;
        }
        files.set(path, body.content ?? "");
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/rename(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as {
          from?: string;
          to?: string;
        };
        renameRequests.push(body);
        const content = files.get(body.from ?? "");
        if (content !== undefined && body.to) files.set(body.to, content);
        if (body.from) files.delete(body.from);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );
    await page.route(
      new RegExp(`/api/${orgSlug}/sandbox/${agentId}/draft/unlink(?:\\?|$)`),
      async (route) => {
        const body = route.request().postDataJSON() as { path?: string };
        deleteRequests.push(body);
        if (body.path) files.delete(body.path);
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {},
        });
      },
    );
    await page.route(
      new RegExp(
        `/api/${orgSlug}/sandbox/${agentId}/draft/git/status(?:\\?|$)`,
      ),
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          json: {
            not_added: [],
            conflicted: [],
            created: [],
            deleted: [],
            modified: [],
            renamed: [],
            files: [],
            staged: [],
            ahead: 0,
            behind: 0,
            current: "draft",
            tracking: null,
            detached: false,
          },
        });
      },
    );

    const selectAllShortcut = await page.evaluate(() =>
      navigator.platform.toLowerCase().includes("mac") ? "Meta+A" : "Control+A",
    );
    const saveShortcut = await page.evaluate(() =>
      navigator.platform.toLowerCase().includes("mac") ? "Meta+S" : "Control+S",
    );
    const replaceAndSave = async (content: string) => {
      const input = page.locator(".monaco-editor textarea.inputarea").first();
      await expect(input).toBeVisible({ timeout: 30_000 });
      await input.focus();
      await input.press(selectAllShortcut);
      await input.press("Backspace");
      await page.keyboard.insertText(content);
      await expect(
        page.locator(".monaco-editor .view-lines").first(),
      ).toContainText(content);
      await input.press(saveShortcut);
    };

    try {
      await page.goto(
        `/${orgSlug}/agents/${agentId}/site-editor/code?thread=${threadId}&sidepanel=false&mainpanel=true`,
      );
      const back = page.getByRole("button", {
        name: "Back to files",
        exact: true,
      });
      const renameFile = page.getByRole("button", {
        name: "rename-me.ts",
        exact: true,
      });
      await expect(renameFile).toBeVisible({ timeout: 30_000 });
      await renameFile.click();
      await replaceAndSave('export const value = "saved before rename";');
      await renameWriteReached.promise;

      await back.click();
      await renameFile.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
      const renameDialog = page.getByRole("dialog", { name: "Rename" });
      await renameDialog
        .getByRole("textbox", { name: "Name" })
        .fill("renamed.ts");
      await renameDialog.locator("form").evaluate((form) => {
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
        form.dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true }),
        );
      });
      await page.waitForTimeout(200);
      expect(renameRequests).toEqual([]);

      releaseRenameWrite.resolve();
      await expect
        .poll(() => renameRequests)
        .toEqual([{ from: "rename-me.ts", to: "renamed.ts" }]);
      await expect(renameDialog).toBeHidden();
      expect(files.has("rename-me.ts")).toBe(false);
      expect(files.get("renamed.ts")).toBe(
        'export const value = "saved before rename";',
      );

      const renamedFile = page.getByRole("button", {
        name: "renamed.ts",
        exact: true,
      });
      await expect(renamedFile).toBeVisible();
      await renamedFile.click();
      await replaceAndSave('export const value = "saved after rename";');
      await expect.poll(() => writePaths).toContain("renamed.ts");
      await expect
        .poll(() => files.get("renamed.ts"))
        .toBe('export const value = "saved after rename";');
      expect(writePaths.filter((path) => path === "rename-me.ts")).toHaveLength(
        1,
      );

      await back.click();
      const deleteFile = page.getByRole("button", {
        name: "delete-me.ts",
        exact: true,
      });
      await deleteFile.click();
      await replaceAndSave('export const value = "saved before delete";');
      await deleteWriteReached.promise;

      await back.click();
      await deleteFile.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
      const deleteDialog = page.getByRole("alertdialog");
      const confirmDelete = deleteDialog.getByRole("button", {
        name: "Delete",
        exact: true,
      });
      await confirmDelete.evaluate((button) => {
        button.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
        button.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      });
      await page.waitForTimeout(200);
      expect(deleteRequests).toEqual([]);

      releaseDeleteWrite.resolve();
      await expect
        .poll(() => deleteRequests)
        .toEqual([{ path: "delete-me.ts", recursive: false }]);
      await expect(deleteDialog).toBeHidden();
      expect(files.has("delete-me.ts")).toBe(false);
      expect(writePaths.filter((path) => path === "delete-me.ts")).toHaveLength(
        1,
      );
      await expect(
        page.getByRole("button", { name: "delete-me.ts", exact: true }),
      ).toHaveCount(0);
    } finally {
      releaseRenameWrite.resolve();
      releaseDeleteWrite.resolve();
    }
  });
});
