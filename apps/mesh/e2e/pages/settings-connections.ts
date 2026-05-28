import { type Page, expect } from "@playwright/test";

/**
 * Wraps the org Settings → Connections screen and its create-connection
 * dialog. Specs should not poke at the DOM directly for these flows — go
 * through this page object so locator changes stay in one place.
 */
export class SettingsConnectionsPage {
  constructor(private readonly page: Page) {}

  async goto(orgSlug: string): Promise<void> {
    await this.page.goto(`/${orgSlug}/settings/connections`);
  }

  async openCreateDialog(): Promise<void> {
    await this.page.getByRole("button", { name: "Custom Connection" }).click();
    await expect(
      this.page.getByRole("heading", { name: "Create Connection" }),
    ).toBeVisible();
  }

  /**
   * Fill the HTTP variant of the create-connection form. The form defaults
   * to HTTP, so no type-toggle is needed; if that changes, switch it here.
   */
  async fillHttpConnection(opts: { name: string; url: string }): Promise<void> {
    await this.page.getByPlaceholder("My Connection").fill(opts.name);
    await this.page.getByPlaceholder("https://example.com/mcp").fill(opts.url);
  }

  /**
   * Click the dialog's Create button. Uses `.last()` because the same
   * "Create Connection" label appears on the page-level CTA behind the
   * open dialog.
   */
  async submit(): Promise<void> {
    await this.page
      .getByRole("button", { name: "Create Connection" })
      .last()
      .click();
  }

  /** Click an access tab by its label (the button text also carries a count badge). */
  async clickTab(label: "All" | "Shared" | "Personal"): Promise<void> {
    await this.page
      .getByRole("button", { name: new RegExp(`^${label}\\b`) })
      .click();
  }

  /** Assert a connection card with the given title is visible. */
  async expectConnectionVisible(title: string): Promise<void> {
    await expect(this.page.getByText(title, { exact: true })).toBeVisible();
  }

  /** Assert no connection card with the given title is present. */
  async expectConnectionHidden(title: string): Promise<void> {
    await expect(this.page.getByText(title, { exact: true })).toHaveCount(0);
  }
}
